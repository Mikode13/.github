# Content plugin versioning

This opt-in extension versions a single bundle with paired
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` manifests. It uses Bash,
`jq`, and GitHub CLI on the hosted runner; consumers need no Node.js project, package
manager, registry publication, or release PR.

This workflow family supports repositories whose default branch is `main`. Inspection
and publication both enforce that boundary.

## Version contract

The PR title supplies the Conventional Commit type. Branch names do not select releases.
For changes to distributed content:

| PR contract                                                       | Increment                        | From `0.1.0` |
| ----------------------------------------------------------------- | -------------------------------- | ------------ |
| `fix: ...` or `fix(scope): ...`                                   | patch                            | `0.1.1`      |
| `feat: ...` or `feat(scope): ...`                                 | minor                            | `0.2.0`      |
| `type!: ...`, `type(scope)!: ...`, or a `BREAKING CHANGE:` footer | major                            | `1.0.0`      |
| Other types, including `docs:` and `ci:`                          | rejected for distributed changes | unchanged    |

No distributed change means no release, regardless of title. README, project documentation,
and workflow changes alone do not require a bump. An initial paired bundle starts at
`0.1.0`. Versions must be numeric `MAJOR.MINOR.PATCH`, with at most nine digits per
component; prerelease identifiers are outside this contract.

The distributed inventory includes `skills/` (including references and scripts),
`.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `AGENTS.md`, `CLAUDE.md`, and
`LICENSE`. Both manifest objects are compared with only `version` excluded. Git tree
comparison includes additions, deletions, renames, and modes without relying on the
changed-file API's size limit. A truncated tree or an unreadable manifest fails the check.
Bundles using other content roots need an explicit contract extension before adoption.

A releasing PR calculates its version from current `main` and the complete diff, never from
the previous bot commit. Updating either manifest manually cannot compound the bump.
Both hosts must name the same plugin and publish the same version.

For reversions, use a Conventional Commit title such as `fix: revert the review change`
(or a breaking marker if reverting breaks the contract), and calculate a new version;
do not restore old manifest versions. GitHub's default `Revert "..."` title is not part
of this contract. Non-breaking `perf:` and `refactor:` also need `fix:` or `feat:` when
they change the bundle. Marketplace metadata is deliberately distributed content, so
editing `.agents/plugins/marketplace.json` requires a release too.

## Consumer workflows

Pin every reusable workflow to the same reviewed full commit SHA.

1. In the `CI` caller, enable `documentation: true` and
   `documentation_plugin_versions: true`. The extension participates in the existing
   `CI / required` aggregate. `working_directory` may select a fixture/subdirectory for
   validation; the bot and release workflows operate on the repository root only. Keep
   the caller at `.github/workflows/ci.yml` with workflow name `CI`.
2. Run CI on PR `opened`, `synchronize`, `reopened`, `edited`, and `ready_for_review`
   events, plus pushes to `main`. A changed title or breaking footer must be rechecked.
3. Add a `pull_request_target` caller for those PR events, targeting `main`, which invokes
   [`plugin-version.yml`](../.github/workflows/plugin-version.yml). Grant its normal token
   `contents: read` and `pull-requests: read`. Pass the App client ID as `client_id` and
   private key as the `private_key` secret. Use per-PR concurrency with cancellation.
4. Add a `workflow_run` caller for completed successful `CI` pushes to `main`, invoking
   [`plugin-release.yml`](../.github/workflows/plugin-release.yml) with the run ID as the
   string `ci_run_id`. Grant `contents: write`, `actions: read`, and `checks: read`.
   Serialize releases without cancellation. A `workflow_dispatch` retry may supply the
   same CI run ID; the reusable workflow verifies it again.

Prefer squash defaults `squash_merge_commit_title=PR_TITLE` and
`squash_merge_commit_message=PR_BODY` to preserve the reviewed intent in Git history.
An administrator can set these through the repository settings or the
[repository API](https://docs.github.com/en/rest/repos/repos#update-a-repository).
This is a history convention: definitive version validation does not depend on the
squash message or its list of individual commits.

Install a dedicated GitHub App only on the consumer repository, with **Contents: write**
and the implicit Metadata permission. The App does not need PR write access, OAuth user
authorization, webhooks, or a ruleset bypass. Store its key in an Actions secret; never
commit it. App installation tokens allow the manifest commit to trigger normal PR CI.

For `Mikode13/skills`, the caller uses variable `MIKODE_SKILLS_VERSION_APP_CLIENT_ID` and
secret `MIKODE_SKILLS_VERSION_APP_PRIVATE_KEY`.

## Trust and concurrency

The privileged workflows check out only this central repository at the revision defining
the reusable workflow. They never check out or execute PR code. GitHub supplies tree and
blob data; JSON parsing preserves all manifest fields except the calculated version.
The App token is minted only if an update is needed, limited to the caller repository,
and revoked by the token action when the job ends.

The writer rechecks PR state, repository, branch, title, body, head, and live main before
committing. GitHub's `createCommitOnBranch` mutation writes exactly the two manifest files
with `expectedHeadOid`; a concurrent push causes failure instead of overwriting it.
Draft and fork PRs receive no bot commit. Fork authors set both versions themselves and
pass the same read-only CI check.

PR changes are compared with the merge-base of the live `main` ref and PR head.
`pull_request.base.sha` is not used, including after title/body edits. Only changes to the
bundle, manifest repairs, or version corrections require that merge-base to equal current
main. README/CI-only PRs can pass this version check while behind main; repository rulesets
may independently require updated branches. This also keeps the central fixture from
adding a freshness requirement to unrelated central changes.

An older PR whose bundle and manifest contents are entirely unchanged also inherits
main's current adoption or repair at merge. This includes PRs opened before both host
manifests existed. Adding content without manifests or deleting a manifest still fails.

When a release PR falls behind main, update the branch and resolve any manifest conflict;
the bot recalculates. There is no automatic rebase or conflict resolution. The central
fixture has no App writer: a PR that changes its distributed content uses a release title
and sets the fixture's expected version manually.

The first functional PR check can fail before the App commit arrives; CI runs again on
that new head. `edited` also reruns full CI on PR body edits, because the breaking footer
belongs to the review contract. These are expected effects of the current event wiring.

## Releases and recovery

On push, CI reads the definitive commit's actual parent and validates the two manifests
as one published version. Changed content requires exactly one patch, minor, or major
increment; unchanged content retains its version. Missing bumps, downgrades, skipped
increments, and discrepant host versions fail. The increment type was selected in PR CI;
push CI does not reinterpret it from a possibly edited squash message.

If one base manifest is missing or their numeric versions disagree, planning uses the
highest existing numeric version. Adding a missing host or changing payload then applies
the PR's increment normally. A version-only reconciliation can align both hosts to that
maximum without another bump; publication does not recreate its existing tag. Both head
manifests must be valid. Unparseable JSON and unsupported version syntax remain explicit
errors, rather than guessing a safe previous release number.

After main CI succeeds, the release script verifies the actual CI run, its successful
`CI / required` check suite, and main ancestry. It reads versions from that exact commit
and its parent. A new version creates `v<version>` at the commit and a GitHub Release
with generated notes. It never updates the default branch or moves an existing tag.

Retries reuse a matching tag/release, including recovery after tag creation alone. A tag
pointing elsewhere is an error requiring investigation. Publication performs no npm work.
The version committed to the manifests is the host update signal; the release records
the history. Verify updates in already-installed Claude Code and Codex clients during
rollout; CI cannot exercise their local plugin caches.

The PR introducing the `pull_request_target` caller needs its initial version set
manually, because that event uses workflow code from the default branch. After merging,
use a real skill correction PR to verify the App commit and its subsequent CI run.

## Validation

The integration suites execute these shipped scripts with real Bash and `jq`, replacing
only GitHub's API boundary. They cover release classification, repeat runs, immutable
snapshots, forks, malformed inputs, races, and publication provenance. The `plugin_content`
CI fixture exercises read-only validation through the reusable Documentation job against
GitHub, without a package manifest in the consumer fixture.

Run `pnpm run check` and `pnpm test` in this central repository. App installation, token
permissions, and client updates require the consumer rollout; offline tests do not prove
those external integrations.
