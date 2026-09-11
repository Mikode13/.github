#!/usr/bin/env bash
set -euo pipefail

plan="${PLUGIN_VERSION_PLAN:?Set PLUGIN_VERSION_PLAN}"
[[ "$(jq -r .needs_update "$plan")" == true ]] || exit 0
repository="$(jq -r .context.repository "$plan")"
number="$(jq -r .context.number "$plan")"
head="$(jq -r .context.head "$plan")"
base="$(jq -r .context.base "$plan")"
branch="$(jq -r .context.branch "$plan")"
default_branch="$(jq -r .context.default_branch "$plan")"
version="$(jq -r .version "$plan")"

jq -e --arg repository "$GITHUB_REPOSITORY" '
  .context.repository == $repository and .context.head_repository == $repository and
  .context.branch != .context.default_branch and (.context.number | type == "number")
' "$plan" > /dev/null

# The read token has PR metadata access; the App token only needs Contents: write.
current_pr="$(GH_TOKEN="$READ_TOKEN" gh api --method GET "repos/$repository/pulls/$number")"
jq -e --slurpfile plan "$plan" '
  $plan[0].context as $expected |
  .state == "open" and .draft == false and
  .head.repo.full_name == $expected.repository and .base.repo.full_name == $expected.repository and
  .head.ref == $expected.branch and .base.ref == $expected.default_branch and
  .head.sha == $expected.head and
  .title == $expected.title and (.body // "") == $expected.body
' <<< "$current_pr" > /dev/null || { echo '::error::PR changed while preparing the version commit. Rerun the workflow.' >&2; exit 1; }
encoded_branch="$(jq -rn --arg value "$default_branch" '$value | @uri')"
current_base="$(GH_TOKEN="$READ_TOKEN" gh api --method GET "repos/$repository/git/ref/heads/$encoded_branch" | jq -er .object.sha)"
[[ "$base" == "$current_base" ]] || { echo '::error::Default branch changed. Update the PR and rerun.' >&2; exit 1; }

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/plugin-version-write.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
for host in claude codex; do
  jq --tab ".manifests.$host" "$plan" > "$work/$host.json"
done
jq -n --arg repository "$repository" --arg branch "$branch" --arg head "$head" \
  --arg message "chore: set plugin version to $version" --slurpfile plan "$plan" \
  --rawfile claude "$work/claude.json" --rawfile codex "$work/codex.json" '
  ($plan[0].context.directory | if . == "" then "" else . + "/" end) as $prefix |
  {query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
   variables: {input: {branch: {repositoryNameWithOwner: $repository, branchName: $branch},
     expectedHeadOid: $head, message: {headline: $message}, fileChanges: {additions: [
       {path: ($prefix + ".claude-plugin/plugin.json"), contents: ($claude | @base64)},
       {path: ($prefix + ".codex-plugin/plugin.json"), contents: ($codex | @base64)}]}}}}
' > "$work/request.json"

# GitHub atomically rejects a moved head; no force push or branch-protection bypass.
GH_TOKEN="$APP_TOKEN" gh api graphql --input "$work/request.json" > "$work/result.json"
jq -e '.errors == null and (.data.createCommitOnBranch.commit.oid | test("^[0-9a-f]{40}$"))' \
  "$work/result.json" > /dev/null
echo "Committed plugin version $version to PR #$number."
