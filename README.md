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
- `documentation` runs central Markdown formatting, structure, and internal-link checks,
  using the shared `@mikode13/code-style` formatting export from a pinned toolchain.
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
`package.json`, or a pnpm lockfile. The central workflow brings its own tooling to validate
the repository's Markdown files -- see [Documentation toolchain](#documentation-toolchain).

The workflow always produces an aggregate job named `required`. A thin caller names its
reusable-workflow job `CI`, which gives the organization ruleset the stable status context
`CI / required`.

This repository exercises several caller shapes in one validation workflow instead of using
a single thin caller. Its own final aggregate is named `CI / required` directly so local
validation reports the same protected status as consuming repositories.

### Documentation toolchain

[`docs-toolchain/`](docs-toolchain) holds a `package.json` and its own `pnpm-lock.yaml`,
pinning Prettier, `markdownlint-cli2`, `remark-cli`, `remark-validate-links`, and
`@mikode13/code-style` exactly. Like [`release-toolchain/`](#release-toolchain), it is
deliberately excluded from this repository's own workspace and installed with
`--ignore-workspace`, so its dependency graph is frozen independently of everything else
here.

The Documentation job resolves which commit of _this_ repository to take the toolchain from
using `job.workflow_sha` and `job.workflow_repository`, checks it out into
`.mikode-docs-toolchain`, and moves it to `runner.temp` before scanning for Markdown -- the
same checkout-and-move mechanics, for the same `actions/checkout` reason, as the release
toolchain. The move happens before the scan so a repository validated with
`working_directory: .` never finds the toolchain's own files among its own.

The tools are invoked by path (`node .../node_modules/prettier/bin/prettier.cjs`) rather
than through `pnpm exec`. A cone-mode sparse checkout still brings the repository's
root-level files along, so `pnpm-workspace.yaml` and this repository's own `package.json`
land next to the toolchain; `pnpm exec` would resolve against that workspace and run its
`prepare` script, which has nothing installed there. `--ignore-workspace` covers the
install step and nothing covers `exec`.

The toolchain owns two configuration files, both committed and reviewable:

- [`docs-toolchain/prettier.config.mjs`](docs-toolchain/prettier.config.mjs) re-exports
  `@mikode13/code-style/prettier`, the same shared export the Source capability resolves.
  It replaced an inline `printf '{}'` that gave Prettier its own defaults: the Documentation
  capability formatted embedded code blocks with spaces and double quotes while Source
  formatted the same file with tabs and single quotes, so any repository with Markdown code
  examples could not satisfy both. No repository had hit it only because no caller yet
  combined `documentation` with Markdown code samples.
- [`docs-toolchain/.markdownlint-cli2.jsonc`](docs-toolchain/.markdownlint-cli2.jsonc)
  disables `MD010` inside fenced code blocks, because the shared formatter indents embedded
  code with tabs, and disables `MD013`, because line length belongs to `printWidth`.

`fixtures/docs-source` is validated by the Source **and** Documentation capabilities in the
same run (the `source and documentation fixture` job), over Markdown whose code blocks
Prettier's defaults would rewrite.
[`tests/integration/documentationFormatting.integration.test.ts`](tests/integration/documentationFormatting.integration.test.ts),
part of `pnpm test`, proves the same agreement offline: it installs the pinned toolchain, checks
that both configurations resolve to one option object, runs the real formatter and linter
over the fixture, asserts the workflow step neither writes its own Prettier configuration nor
resolves tooling at runtime, and asserts that the fixture still fails under Prettier's
defaults -- so the fixture cannot quietly stop being a regression test.

The legacy `docs` profile is unchanged: it still installs the repository's own dependencies
and runs its own `docs:check`, so repository-specific document invariants stay composable.

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

### npm authentication

The release job performs the OIDC trusted-publishing exchange itself, in the
"Authenticate to npm through OIDC trusted publishing" step, and appends the returned
short-lived token to a project-level `.npmrc` in the consumer's working directory. The
token is masked before it can reach any later log line, and npm always excludes `.npmrc`
from a published tarball, so it cannot reach the artifact.

This exists because `@semantic-release/npm@13.1.5` does **not** authenticate for you.
Its `verify-auth.js` exchanges an OIDC token only to prove trusted publishing is
possible, then returns early without writing any credential, leaving `npm publish` to
repeat the exchange itself. In a real release of `@mikode13/tsconfig` on 2026-09-06 npm
did not, and the publish failed with `ENEEDAUTH` **after** semantic-release had already
pushed the `v1.0.0` tag -- a partial release needing manual reconciliation. A
project-level `.npmrc` outranks the `--userconfig` file the plugin passes, so writing the
credential there is what makes the plugin's own `npm publish` call authenticate.

The publish step also sets `NPM_CONFIG_PROVENANCE`, because ADR 0011 requires public
packages to be published with provenance and neither this workflow nor the plugin passes
`--provenance`.

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

The suites under [`tests/integration/`](tests/integration) (run by `pnpm test`) each use
[`tests/support/fixtures/workflowStep.fixture.ts`](tests/support/fixtures/workflowStep.fixture.ts)
to pull the literal script out of one `release.yml` step and execute it directly -- the
same text that ships in production, not a hand-copied duplicate that can drift out of
sync:

- Authorization is tested against
  [`tests/support/fakes/gh.fake.cjs`](tests/support/fakes/gh.fake.cjs), a scriptable fake
  `gh` binary, covering a matching SHA, a mismatched SHA, no run on
  `main`/`push`, a failed CI run, a missing or failed `CI / required` check, a check
  belonging to a different check suite, and that every call used `GET`.
- The toolchain is tested end to end against a real local Git remote -- see
  [Release toolchain](#release-toolchain) below.
- Semver rules are tested against the real `@semantic-release/commit-analyzer` plugin
  from the pinned toolchain (not a separate root-level copy), covering every ADR 0011
  partition plus the breaking-`perf`/breaking-`revert` regression cases the rule-ordering
  fix above exists for.
- npm authentication is tested against a local stand-in for both endpoints the step
  talks to, GitHub's OIDC token service and the registry's package-scoped exchange. It
  covers a successful exchange (the credential lands where npm reads it, the token is
  masked, the scoped package name is URL encoded, and the exchange presents the GitHub
  OIDC token rather than the runner's request token), a consumer's existing `.npmrc`
  surviving, a missing OIDC context failing loudly and making no network call, and a
  rejected exchange naming the Trusted Publisher as the likely cause.
- Package validation runs against two fixtures under `tests/support/fixtures/`: one with
  a built `dist/` (must pass) and one without (must fail) -- the second reproduces the
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
   this workflow's `release` job runs under `environment: npm`. **Leave npm's Trusted
   Publisher "Environment name" field blank.** This was previously unconfirmed for a
   `workflow_call` setup; a real release attempt from `@mikode13/tsconfig` on 2026-09-06
   settled it. With the field blank, the package-scoped OIDC token exchange returned
   `200` and npm accepted the token, so npm does not require the field to match the
   environment the job declares.

**npm Trusted Publisher configuration gotcha**: npm matches a Trusted Publisher entry
against the **calling repository's own workflow filename** (for example
`cross-platform`'s `.github/workflows/release.yml`), not this repository's
`release.yml` that actually runs `npm publish`. Register each package's Trusted
Publisher on npmjs.com against the consumer's caller filename, not this one.

### Release toolchain

[`release-toolchain/`](release-toolchain) holds a `package.json` and its own
`pnpm-lock.yaml`, pinning `semantic-release` and every plugin exactly. It is
deliberately excluded from this repository's own workspace (`pnpm-workspace.yaml` does
not list it, and it is installed with `--ignore-workspace`) so its dependency graph
never mixes with, or gets bumped incidentally by, anything else here.

The `release` job derives which commit of _this_ repository to pin the toolchain to from
`job.workflow_sha` and `job.workflow_repository` -- the exact commit that defines the
currently-running reusable workflow, for a job inside a `workflow_call`. It does not ask
the caller for this: a caller only pins `uses: .../release.yml@<SHA>` once, same as the
CI caller contract, and this workflow resolves its own toolchain commit from that same
call. Both properties are validated (40-hex SHA, non-empty repository) before use.
`actionlint` (1.7.12, current latest) does not model either property on the job context
yet, so [`.github/actionlint.yaml`](.github/actionlint.yaml) carries a narrow, path-scoped
ignore for exactly those two messages, with a removal note once actionlint catches up. Both
context values, and the whole mechanism, were verified empirically with a throwaway
`workflow_call` probe before being relied on here, not merely read about.

The toolchain is checked out at that commit into `.mikode-release-toolchain` (a
repository-relative path, not directly under `runner.temp`) and immediately moved there
with a plain `mv`. This two-step dance is required, not stylistic: `actions/checkout`
(including this pinned `v7.0.1`) resolves its `path` input against `GITHUB_WORKSPACE`
and throws `Repository path '...' is not under '...'` for anything outside it, before
any network call -- confirmed by running the pinned action's own `dist/index.js`
locally with these exact inputs. The move itself is safe even though
`persist-credentials: false` already ran during the checkout step: the action's
post-step cleanup checks for `.git/config` at the _original_ path and returns
immediately once that's gone, so moving it does not trip the action's own teardown.
Once relocated, it's installed with `pnpm install --frozen-lockfile --ignore-workspace`,
and the "Write semantic-release configuration" step also writes `release.config.cjs`
there -- so nothing this workflow generates or installs can ever end up inside the
consumer's own tree or its published tarball (the tarball-verification step also
asserts `release.config.cjs` is absent from the pack list, as a regression guard).
`semantic-release` is then invoked with `--extends` pointing at that config file: a
plugin named in an extended config resolves relative to _that config file's own
directory_, so plugins load from the toolchain's `node_modules` regardless of
`working-directory` staying the consumer's own directory for git operations. This was
verified empirically against a scratch repository with a real local bare Git remote and
no local `node_modules` at all, not assumed from reading semantic-release's source.

[`tests/integration/releaseToolchain.integration.test.ts`](tests/integration/releaseToolchain.integration.test.ts)
(run by `pnpm test`, alongside the other release-workflow suites) installs the real pinned
toolchain, extracts and runs the real config-writer script into it, strips the `npm`/`github` plugins (the only
two needing real network access), and runs a real `semantic-release --dry-run --no-ci
--extends` against a scratch repository with an existing `v1.0.0` tag and one breaking
`perf` commit -- asserting both the computed `2.0.0` version and the rendered
`BREAKING CHANGES` / `Performance Improvements` notes headings. This is what actually
caught `conventional-changelog-conventionalcommits@10` silently breaking
`@semantic-release/release-notes-generator@14` with a "missing helper" error: no
analyzer-only test could have, since the incompatibility was specific to notes
generation.

That suite's own child processes are run with a scrubbed environment (every
`CI`/`GITHUB_*`/`RUNNER_*`/`ACTIONS_*` variable stripped, everything else preserved) --
without it, running the test inside GitHub Actions leaks the outer job's own
`GITHUB_REF` (a pull request's merge ref) into the inner dry-run's branch detection,
since `--no-ci` only skips the "is this CI" gate, not environment-reported branch
resolution. Reproduced locally by exporting those variables before finding the fix. The
scratch bare repository's `HEAD` is also pinned explicitly to `refs/heads/main` after
creation, rather than trusting `init.defaultBranch`: this repository's own git and the
GitHub Actions runner's git disagreed on that default, which is exactly the kind of gap
that only shows up once code actually runs somewhere else.

The same suite also runs a second time, unmodified, as **`release toolchain
mechanics`** in `validate-workflows.yml` -- pointed at a toolchain installed via the
real `actions/checkout` + move dance described above (via the
`RELEASE_TOOLCHAIN_DIRECTORY` environment variable) against this repository's own
`github.sha`, on every pull request. This is the job that would have caught the
`GITHUB_WORKSPACE` defect above: running the suite in place never invokes the real
checkout action at all, so no purely offline test could have caught a bug that only
exists in that action's own runtime behavior.

## Developing the workflows

The repository validates workflow syntax and exercises retained profiles and explicit
capability composition with contract fixtures:

```sh
pnpm install --frozen-lockfile
pnpm run check          # formatting, linting, type checks, CI status contract
pnpm test               # the offline workflow suites in tests/integration
pnpm run test:fixtures  # the contract fixtures' own suites
```

`check` is formatting, linting and type checking only, as the git workflow standard
requires; everything that asserts behaviour lives in `pnpm test`. `test:fixtures` is
separate because those suites belong to the contract fixtures rather than to this
repository -- CI runs them through the reusable workflow itself.

The content-only documentation fixture deliberately has no `package.json` or pnpm lockfile.
It verifies the boundary introduced by ADR 0015 rather than simulating project tooling. The
source-and-documentation fixture is the opposite case: it exists to prove the two
capabilities format the same Markdown identically.

Pull requests additionally run actionlint and every retained profile and capability
fixture through the reusable CI workflow itself. The outer `required` job covers all of
those checks. `pnpm test` covers the release and documentation workflow suites -- see
[Testing this workflow without touching npm or GitHub for real](#testing-this-workflow-without-touching-npm-or-github-for-real)
above.

## License

This repository is source-available under the MIT License with the Commons Clause License
Condition v1.0. See [`LICENSE`](LICENSE) for the complete terms.
