#!/usr/bin/env bash
set -euo pipefail
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

repository="${GITHUB_REPOSITORY:?}"
run_id="${PLUGIN_CI_RUN_ID:?}"
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo '::error::Invalid CI run ID' >&2; exit 1; }
get() { gh api --method GET "$1"; }
fail() { echo "::error::$1" >&2; exit 1; }
[[ "$(get "repos/$repository" | jq -er .default_branch)" == main ]] || fail 'Plugin releases support repositories whose default branch is main'

# Re-read the completed run, including on manual retries. Event payloads alone do not
# authorize publication; CI must have validated this exact definitive main commit.
run="$(get "repos/$repository/actions/runs/$run_id")"
jq -e --arg repository "$repository" '
  .name == "CI" and .path == ".github/workflows/ci.yml" and .event == "push" and
  .head_branch == "main" and .conclusion == "success" and .status == "completed" and
  .head_repository.full_name == $repository and (.head_sha | test("^[0-9a-f]{40}$"))
' <<< "$run" > /dev/null || fail 'A successful main push run of CI is required'
sha="$(jq -r .head_sha <<< "$run")"
suite="$(jq -er .check_suite_id <<< "$run")"
gh api --method GET --paginate --slurp "repos/$repository/check-suites/$suite/check-runs?filter=latest&per_page=100" |
  jq -e --arg sha "$sha" '[.[].check_runs[] | select(.name == "CI / required" and .head_sha == $sha)] |
    length == 1 and all(.conclusion == "success")' > /dev/null || fail 'CI / required did not succeed for this commit'
comparison="$(get "repos/$repository/compare/$sha...main")"
[[ "$(jq -r .merge_base_commit.sha <<< "$comparison")" == "$sha" ]] || fail 'The release commit must belong to main'
commit="$(get "repos/$repository/commits/$sha")"
[[ "$(jq '.parents | length' <<< "$commit")" == 1 ]] || fail 'Plugin releases require the squash merge contract'
parent="$(jq -r '.parents[0].sha' <<< "$commit")"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/plugin-release.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
for revision in "$parent" "$sha"; do
  get "repos/$repository/git/trees/$revision?recursive=1" > "$work/tree.json"
  jq -e '.truncated == false' "$work/tree.json" > /dev/null || fail 'Incomplete Git tree'
  for host in claude codex; do
    blob="$(jq -r --arg path ".$host-plugin/plugin.json" '[.tree[] | select(.path == $path and .type == "blob" and .mode == "100644")][0].sha // empty' "$work/tree.json")"
    if [[ -z "$blob" && "$revision" == "$parent" ]]; then
      echo null > "$work/$revision-$host.json"
      continue
    fi
    [[ -n "$blob" ]] || fail 'Both release manifests must be regular files'
    get "repos/$repository/git/blobs/$blob" | jq -er 'select(.encoding == "base64") | .content' |
      base64 --decode > "$work/$revision-$host.json"
  done
done
version="$(jq -L "$script_directory" -ner --slurpfile claude "$work/$sha-claude.json" --slurpfile codex "$work/$sha-codex.json" '
  include "version";
  ($claude[0] | validate_manifest) as $c | ($codex[0] | validate_manifest) as $d |
  if $c.name == $d.name and $c.version == $d.version
  then $c.version
  else error("Plugin manifests disagree") end')"
# A version-only repair can reuse the highest already-published host version. It must
# not attempt to recreate an immutable tag owned by that earlier release.
previous="$(jq -L "$script_directory" -nr --slurpfile claude "$work/$parent-claude.json" --slurpfile codex "$work/$parent-codex.json" '
  include "version"; {claude: $claude[0], codex: $codex[0]} | previous_version')"
if [[ "$previous" == "$version" ]]; then
  echo 'No plugin version change; no release is needed.'
  exit 0
fi

tag="v$version"
refs="$(get "repos/$repository/git/matching-refs/tags/$tag")"
existing="$(jq -c --arg ref "refs/tags/$tag" '.[] | select(.ref == $ref)' <<< "$refs")"
if [[ -n "$existing" ]]; then
  jq -e --arg sha "$sha" '.object.type == "commit" and .object.sha == $sha' <<< "$existing" > /dev/null || fail 'The version tag already points to another commit; never move it'
else
  jq -n --arg ref "refs/tags/$tag" --arg sha "$sha" '{ref: $ref, sha: $sha}' > "$work/tag.json"
  gh api --method POST "repos/$repository/git/refs" --input "$work/tag.json" > /dev/null
fi

gh api --method GET --paginate --slurp "repos/$repository/releases?per_page=100" > "$work/releases.json"
if jq -e --arg tag "$tag" '[.[][] | select(.tag_name == $tag and .draft == false)] | length > 0' "$work/releases.json" > /dev/null; then
  echo "Release $tag already exists."
  exit 0
fi
jq -n --arg tag "$tag" --arg sha "$sha" '{tag_name: $tag, target_commitish: $sha,
  name: $tag, generate_release_notes: true, make_latest: "legacy"}' > "$work/release.json"
gh api --method POST "repos/$repository/releases" --input "$work/release.json" > /dev/null
echo "Published $tag for $sha."
