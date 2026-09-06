# MiKode GitHub configuration

This repository contains MiKode's public organization profile, shared community health
files, and centralized GitHub Actions workflows.

## Organization profile

The profile shown on the organization page lives in [`profile/README.md`](profile/README.md).

## Reusable continuous integration

The reusable workflow at [`.github/workflows/ci.yml`](.github/workflows/ci.yml) implements
the [MiKode continuous integration standard](https://github.com/Mikode13/engineering/blob/main/standards/continuous-integration.md).

### Capability contract

This workflow revision supports these independently composable capabilities:

- `source` runs `pnpm run check` on Node.js 24.
- `tests` runs `pnpm test` on Node.js 22 and 24.
- `build` runs `pnpm run build` on Node.js 22 and 24.
- `package` runs `pnpm run pack:check` on Node.js 24.
- `documentation` runs central Markdown formatting, structure, and internal-link checks.
- `end_to_end` installs Playwright browsers and runs `pnpm run test:e2e`.

The catalogue belongs to this immutable workflow revision. Future reviewed revisions may add
new capabilities. Enabling one capability does not implicitly enable another.

A new caller selects every applicable capability explicitly:

```yaml
with:
  source: true
  tests: true
  build: true
  documentation: true
```

The Documentation capability does not require the consuming repository to own Node.js, pnpm,
`package.json`, or a pnpm lockfile. The central workflow may use its own tooling to validate
the repository's Markdown files.

The workflow always produces an aggregate job named `required`. A thin caller names its
reusable-workflow job `CI`, which gives the organization ruleset the stable status context
`CI / required`.

This repository exercises several caller shapes in one validation workflow instead of using
a single thin caller. Its own final aggregate is named `CI / required` directly so local
validation reports the same protected status as consuming repositories.

### Legacy profiles

Existing SHA-pinned callers remain compatible with the previous profile contract:

- `node` expands to Source + Tests.
- `package` expands to Source + Tests + Package.
- `docs` expands to Documentation.
- `run_build: true` adds Build to a compatible profile.
- `run_e2e: true` adds End-to-end to a compatible profile.

Callers must use either explicit capability inputs or the legacy profile contract, not both.

### Caller contract

A repository caller must:

1. Run on pull requests targeting `main` and pushes to `main`.
2. Grant only `contents: read` unless a documented capability needs more.
3. Cancel superseded pull request runs through a per-pull-request concurrency group.
4. Pin this repository's reusable workflow to a full commit SHA.
5. Enable every capability that applies to the repository.

### Required status migration

A repository must observe `CI / required` from its chosen caller revision before adding that
context to branch protection. When replacing another required context, keep the existing
gate until the new status has passed, require the new context, and only then retire the old
requirement and its producer. This prevents an unprotected interval or a permanently pending
check. Follow the controlled rollout in the
[continuous integration standard](https://github.com/Mikode13/engineering/blob/main/standards/continuous-integration.md#central-workflow-changes).

The organization template at [`workflow-templates/ci.yml`](workflow-templates/ci.yml) still
uses the legacy publishable-package profile for compatibility. A later validated workflow
release can move the template to explicit capabilities without changing existing pinned
callers.

### Known-good workflow releases

| Release | Reusable workflow SHA                                                                                                             | Validation                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial | [`78523ec52c5a598be22e8682cee47409bbe9b4a5`](https://github.com/Mikode13/.github/commit/78523ec52c5a598be22e8682cee47409bbe9b4a5) | [Default-branch CI](https://github.com/Mikode13/.github/actions/runs/32670985582) |

Callers pin the full SHA from this table. A new validated release becomes the default for
new or deliberately upgraded callers, while the preceding entry remains the immediate
rollback target.

## Reusable release

The reusable workflow at [`.github/workflows/release.yml`](.github/workflows/release.yml)
implements [ADR 0011](https://github.com/Mikode13/engineering/blob/main/adr/0011-use-semantic-release-for-automated-npm-publication.md):
publish independently versioned npm packages with `semantic-release` from Conventional
Commits, using npm's OIDC Trusted Publishing (no stored `NPM_TOKEN`).

### Authorization

The workflow takes a single `sha` input and never trusts the caller's own judgment about
what triggered it. It independently re-verifies, through the GitHub API, that:

1. a workflow run named `CI` completed successfully for that exact `sha`, on `main`, from
   a `push` event; and
2. that run's check suite contains a successful `CI / required` check -- the actual status
   that gates merges, not merely "some job in some workflow succeeded."

Both calls use `gh api --method GET` explicitly (`gh api` silently switches to `POST`
once `-f` parameters are present otherwise). The workflow name is not configurable: a
caller able to choose which workflow's success gates its own release would defeat the
point of the gate.

### Artifact preparation

Before invoking `semantic-release`, the release job runs `pnpm run --if-present build`
and then verifies the resulting tarball (`npm pack --dry-run --json`) actually contains
every file the package declares as public -- every string reachable from `main`,
`module`, `types`/`typings`, `exports`, and `bin`. This exists because a package can pass
CI while still publishing broken: nothing in the CI capability contract requires `dist/`
to exist outside of a project's own `prepack` hook, which is easy to forget entirely.

### Release configuration

The commit-analyzer's custom release rules (which commit `type`s trigger which SemVer
bump, per ADR 0011's table) are embedded directly in the "Write semantic-release
configuration" step's script, not read from a sibling file -- a reusable workflow cannot
read a file from its own defining repository at run time, so embedding means the
caller's pinned commit SHA already guarantees which rules ran. Rule order matters:
`{ breaking: true, release: 'major' }` must be evaluated before the rules that suppress
`perf`/`revert`, because commit-analyzer ranks a `release: false` match as more severe
than any real release type once matched, and can never be overridden by a later rule --
only evaluating the breaking rule first, so commit-analyzer's early-stop-at-major
behavior skips the suppression rules entirely for a breaking commit, produces the
correct result for `perf!` or a `revert` with a `BREAKING CHANGE` footer.

`@semantic-release/github` is configured with `successComment`/`failComment`/
`releasedLabels` all disabled, so the job needs only `contents: write` and
`id-token: write` -- its defaults would otherwise need `issues: write` and
`pull-requests: write`, and a 403 on that unrelated step would report an
already-irreversible release as failed.

### Testing this workflow without touching npm or GitHub for real

`scripts/test-release-authorization.mjs`, `scripts/test-release-semver-rules.mjs`, and
`scripts/test-release-package-validation.mjs` (run as part of `pnpm run check`) each use
[`scripts/lib/extractWorkflowStepScript.mjs`](scripts/lib/extractWorkflowStepScript.mjs)
to pull the literal script out of one `release.yml` step and execute it directly -- the
same text that ships in production, not a hand-copied duplicate that can drift out of
sync:

- Authorization is tested against [`scripts/lib/fakeGh.cjs`](scripts/lib/fakeGh.cjs), a
  scriptable fake `gh` binary, covering a matching SHA, a mismatched SHA, no run on
  `main`/`push`, a failed CI run, a missing or failed `CI / required` check, a check
  belonging to a different check suite, and that every call used `GET`.
- Semver rules are tested against the real `@semantic-release/commit-analyzer` plugin,
  covering every ADR 0011 partition plus the breaking-`perf`/breaking-`revert`
  regression cases the rule-ordering fix above exists for.
- Package validation runs against two fixtures under `scripts/fixtures/`: one with a
  built `dist/` (must pass) and one without (must fail) -- the second reproduces the
  exact defect this check exists to catch.

The workflow's own `workflow_run`/OIDC/publish path is not exercised by this repository's
CI -- that can only be proven once a real consumer adopts it.

### Caller contract

A consuming repository owns a thin caller workflow (not part of this repository) that:

1. Triggers on `workflow_run` for its own `CI` workflow (`types: [completed]`), and
   separately exposes `workflow_dispatch` for manual recovery.
2. Determines the commit SHA to release itself (`github.event.workflow_run.head_sha`, or
   an operator-supplied SHA on manual dispatch) and passes it as the `sha` input --
   this repository's workflow does not depend on `workflow_run` event context surviving
   the `workflow_call` boundary, which is undocumented behavior.
3. Grants `id-token: write` at its own job level, in addition to this reusable workflow
   granting it internally -- npm Trusted Publishing requires both.
4. Pins this repository's `release.yml` to a full commit SHA, same as the CI caller
   contract.
5. Keeps `package.json`'s `version` at `0.0.0-development` in source control; this
   workflow refuses to release otherwise.
6. Before a manual `workflow_dispatch` retry, checks npm (does this version already
   exist?), the expected `v<version>` Git tag, and the GitHub Release for that commit --
   release steps are not atomic, and a version that already exists on npm can never be
   reused or overwritten.
7. Creates a GitHub Environment literally named `npm` in the consumer repository, since
   this workflow's `release` job runs under `environment: npm`. Whether npm's Trusted
   Publisher "Environment name" field must match a caller-level or reusable-workflow-level
   environment is not confirmed by npm's own documentation for a `workflow_call` setup --
   leave that field blank until a real release confirms which one npm actually checks.

**npm Trusted Publisher configuration gotcha**: npm matches a Trusted Publisher entry
against the **calling repository's own workflow filename** (for example
`cross-platform`'s `.github/workflows/release.yml`), not this repository's
`release.yml` that actually runs `npm publish`. Register each package's Trusted
Publisher on npmjs.com against the consumer's caller filename, not this one.

### Known limitation

`npx -p <package>@<exact-version>` pins the top-level release toolchain but still
resolves its transitive dependencies fresh, unpinned, on every run, inside the job
holding `contents: write` and OIDC authority. A follow-up change will commit a dedicated
`package.json` and lockfile for the release toolchain in this repository, checked out at
a full commit SHA once one exists post-merge, and install it with
`pnpm install --frozen-lockfile` instead.

## Developing the workflows

The repository validates workflow syntax and exercises retained profiles and explicit
capability composition with contract fixtures:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
```

The content-only documentation fixture deliberately has no `package.json` or pnpm lockfile.
It verifies the boundary introduced by ADR 0015 rather than simulating project tooling.

Pull requests additionally run actionlint and every retained profile and capability
fixture through the reusable CI workflow itself. The outer `required` job covers all of
those checks. `pnpm run check` also runs the release workflow's own tests -- see
[Testing this workflow without touching npm or GitHub for real](#testing-this-workflow-without-touching-npm-or-github-for-real)
above.

## License

This repository is source-available under the MIT License with the Commons Clause License
Condition v1.0. See [`LICENSE`](LICENSE) for the complete terms.
