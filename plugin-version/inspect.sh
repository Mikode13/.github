#!/usr/bin/env bash
set -euo pipefail

# Only GitHub metadata and JSON blobs are read. No consumer checkout is executed.
mode="${1:?Usage: inspect.sh check|prepare}"
[[ "$mode" == check || "$mode" == prepare ]] || { echo 'Unknown mode' >&2; exit 1; }
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/plugin-version.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

get() { gh api --method GET "$1"; }
fail() { echo "::error::$1" >&2; exit 1; }

jq --arg event "$GITHUB_EVENT_NAME" --arg directory "${PLUGIN_DIRECTORY:-.}" '
  if $event == "pull_request" or $event == "pull_request_target" then
    {repository: .repository.full_name, default_branch: .repository.default_branch,
     number: .number, base: null, head: .pull_request.head.sha,
     branch: .pull_request.head.ref, base_branch: .pull_request.base.ref,
     head_repository: .pull_request.head.repo.full_name,
     title: .pull_request.title, body: (.pull_request.body // ""),
     draft: .pull_request.draft, state: .pull_request.state}
  elif $event == "push" then
    {repository: .repository.full_name, default_branch: .repository.default_branch,
     number: null, base: .before, head: .after, branch: .repository.default_branch,
     base_branch: .repository.default_branch, head_repository: .repository.full_name,
     title: "", body: "", draft: false, state: "open"}
  else error("Plugin version inspection requires a pull request or push event") end |
  .directory = ($directory | sub("^\\./"; "") | if . == "." then "" else . end) |
  .event = $event
' "$GITHUB_EVENT_PATH" > "$work/context.json"

jq -e --arg repository "$GITHUB_REPOSITORY" '
  .repository == $repository and
  ([.repository, .head_repository] | all(test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))) and
  (.head | test("^[0-9a-f]{40}$") and . != ("0" * 40)) and
  (.event != "push" or (.base | test("^[0-9a-f]{40}$") and . != ("0" * 40))) and
  .default_branch == "main" and .base_branch == .default_branch and
  (.directory == "" or (.directory | test("^[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*$") and
    (test("(^|/)\\.\\.?(/|$)") | not)))
' "$work/context.json" > /dev/null || fail 'Invalid repository, revisions, base branch, or plugin directory'

repository="$(jq -r .repository "$work/context.json")"
base="$(jq -r .base "$work/context.json")"
head="$(jq -r .head "$work/context.json")"
default_branch="$(jq -r .default_branch "$work/context.json")"
directory="$(jq -r .directory "$work/context.json")"
prefix="${directory:+$directory/}"

if [[ "$mode" == prepare ]]; then
  [[ "$GITHUB_EVENT_NAME" == pull_request_target ]] || fail 'Writes require pull_request_target'
  if ! jq -e '.state == "open" and .draft == false and .head_repository == .repository and .branch != .default_branch' "$work/context.json" > /dev/null; then
    echo 'No automated version commit for a closed, draft, or fork pull request.'
    echo 'needs_update=false' >> "$GITHUB_OUTPUT"
    exit 0
  fi
fi

if [[ "$GITHUB_EVENT_NAME" != push ]]; then
  encoded_branch="$(jq -rn --arg value "$default_branch" '$value | @uri')"
  current_base="$(get "repos/$repository/git/ref/heads/$encoded_branch" | jq -er .object.sha)"
  [[ "$current_base" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid default branch revision'
  # Compare with the merge-base to isolate this PR's changes, even on an older branch.
  # The event's base SHA and the API's capped changed-file list are not used.
  comparison="$(get "repos/$repository/compare/$current_base...$head")"
  base="$(jq -er .merge_base_commit.sha <<< "$comparison")"
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid merge-base revision'
  jq --arg base "$base" --arg target "$current_base" '.base = $base | .target = $target' \
    "$work/context.json" > "$work/next.json"
  mv "$work/next.json" "$work/context.json"
else
  commit="$(get "repos/$repository/commits/$head")"
  [[ "$(jq '.parents | length' <<< "$commit")" == 1 ]] || fail 'Plugin version checks require a single-parent definitive commit'
  base="$(jq -er '.parents[0].sha' <<< "$commit")"
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid parent revision'
  jq --arg base "$base" '.base = $base' "$work/context.json" > "$work/next.json"
  mv "$work/next.json" "$work/context.json"
fi

for side in base head; do
  sha="$(jq -r ".$side" "$work/context.json")"
  source_repository="$repository"
  [[ "$side" != head ]] || source_repository="$(jq -r .head_repository "$work/context.json")"
  get "repos/$source_repository/git/trees/$sha?recursive=1" > "$work/tree.json"
  jq -e '.truncated == false and (.tree | type == "array")' "$work/tree.json" > /dev/null || fail 'The complete Git tree could not be read'
  jq --arg prefix "$prefix" '{tree: [.tree[] | select(.path | startswith($prefix)) |
    {path: (.path | ltrimstr($prefix)), mode, type, sha}], claude: null, codex: null}' \
    "$work/tree.json" > "$work/$side.json"
  for host in claude codex; do
    manifest_path=".$host-plugin/plugin.json"
    entry="$(jq -c --arg path "$manifest_path" '.tree[] | select(.path == $path)' "$work/$side.json")"
    if [[ -z "$entry" ]]; then
      # Planning distinguishes an unchanged pre-adoption branch from a missing head
      # manifest in a PR that actually changes the bundle.
      continue
    fi
    jq -e '.type == "blob" and .mode == "100644"' <<< "$entry" > /dev/null || fail 'Plugin manifests must be regular files, not symlinks'
    blob="$(jq -r .sha <<< "$entry")"
    get "repos/$source_repository/git/blobs/$blob" > "$work/blob.json"
    jq -e '.encoding == "base64" and (.content | type == "string")' "$work/blob.json" > /dev/null || fail 'Invalid manifest blob'
    jq -r .content "$work/blob.json" | base64 --decode > "$work/manifest.json"
    jq --arg host "$host" --slurpfile manifest "$work/manifest.json" '.[$host] = $manifest[0]' \
      "$work/$side.json" > "$work/next.json"
    mv "$work/next.json" "$work/$side.json"
  done
done

jq -n --slurpfile context "$work/context.json" --slurpfile base "$work/base.json" \
  --slurpfile head "$work/head.json" '{context: $context[0], base: $base[0], head: $head[0]}' |
  jq -L "$script_directory" -f "$script_directory/plan.jq" > "${PLUGIN_VERSION_PLAN:?Set PLUGIN_VERSION_PLAN to an output file}"

# Unrelated README/CI changes must not add a freshness requirement to this capability.
# A release, a manifest repair, or a version correction still needs the current base.
if [[ "$GITHUB_EVENT_NAME" != push ]] &&
   jq -e '.payload_changed or .base_repair or .needs_update' "$PLUGIN_VERSION_PLAN" > /dev/null; then
  [[ "$base" == "$current_base" ]] || fail 'Update the PR branch with the default branch before versioning.'
fi

version="$(jq -r .version "$PLUGIN_VERSION_PLAN")"
needs_update="$(jq -r .needs_update "$PLUGIN_VERSION_PLAN")"
echo "Expected plugin version: $version; manifests need an update: $needs_update"
if [[ "$mode" == check && "$needs_update" == true ]]; then
  fail "Both plugin manifests must declare $version. Wait for the version bot, or update them manually for a fork PR."
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "needs_update=$needs_update"; echo "version=$version"; } >> "$GITHUB_OUTPUT"
fi
