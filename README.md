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

It takes a single, pre-verified `sha` input and independently re-verifies through the
GitHub API that a successful `CI` run exists for that exact commit on `main` before
authorizing anything -- it does not trust a caller's own judgment about what triggered it.
The commit-analyzer's release rules (which `type`s trigger which SemVer bump) are
embedded directly in `release.yml`'s "Write semantic-release configuration" step --
a reusable workflow cannot read a sibling file from its own defining repository at run
time, so the caller's pinned commit SHA is what guarantees which rules ran. A mirror of
that same array lives in
[`release/commit-analyzer-rules.json`](release/commit-analyzer-rules.json), which
[`fixtures/release`](fixtures/release) unit-tests against the real commit-analyzer
plugin; keep both in sync when the rules change.

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

**npm Trusted Publisher configuration gotcha**: npm matches a Trusted Publisher entry
against the **calling repository's own workflow filename** (for example
`cross-platform`'s `.github/workflows/release.yml`), not this repository's
`release.yml` that actually runs `npm publish`. Register each package's Trusted
Publisher on npmjs.com against the consumer's caller filename, not this one.

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
fixture, including `release`, through the reusable CI workflow itself. The outer
`required` job covers all of those checks. The release workflow's own
`workflow_run`/OIDC/publish path is not exercised by this repository's CI -- it can only
be proven end-to-end once a real consumer adopts it.

## License

This repository is source-available under the MIT License with the Commons Clause License
Condition v1.0. See [`LICENSE`](LICENSE) for the complete terms.
