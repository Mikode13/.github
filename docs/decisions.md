# Project decisions

A chronological log of decisions specific to `Mikode13/.github`. Cross-project decisions
live in [`Mikode13/engineering`](https://github.com/Mikode13/engineering), and the
mechanics of each workflow are documented in [`README.md`](../README.md); this file records
the reasoning a future maintainer could not recover from either.

## The Documentation capability formats with the shared export, from a pinned toolchain

**Decision.** The Documentation capability resolves `@mikode13/code-style/prettier` from a
committed [`docs-toolchain/`](../docs-toolchain), rather than passing Prettier an inline
empty configuration and resolving its tools with `pnpm dlx` and `pnpm add` at run time.

**Context.** The step wrote `printf '{}' > prettier.json` and formatted every Markdown file
against it. An empty configuration is not neutral: it selects Prettier's own defaults. On
Markdown containing code examples the two capabilities produced different files — spaces and
double quotes from Documentation, tabs and single quotes from Source — so a repository that
enabled both could not satisfy them at once. Reproduced on a Markdown fixture with `js` and
`json` blocks before anything was changed.

Nothing had failed yet only because no caller combined `documentation` with Markdown code
samples: `Mikode13/engineering` uses the legacy `docs` profile, which runs the repository's
own `docs:check` against the repository's own Prettier resolution, and the content-only
fixture contains prose alone.

The same step resolved `prettier`, `markdownlint-cli2`, `remark-cli`, and
`remark-validate-links` at run time. Version numbers were pinned, but their transitive
graphs were not, so the check that gates every consuming repository could change without a
commit here.

**Consequences.** Documentation now costs a sparse checkout and an install, which is slower
than `pnpm dlx`. The lint configuration has to tolerate what the formatter produces: `MD010`
is disabled inside fenced code blocks because the shared configuration indents embedded code
with tabs, and `MD013` is disabled because line length belongs to `printWidth`. Updating a
documentation tool is now a reviewable lockfile change rather than a silent resolution, and
`@mikode13/code-style` is pinned here like any other dependency — a formatting policy change
reaches the Documentation capability through a deliberate bump, not on its next run.

**Alternatives considered.** Copying the shared option object into a central JSON file would
have removed the checkout, but it recreates the defect one level down: a copy stops tracking
the standard the moment either changes, which is the exact failure `@mikode13/code-style`
exists to prevent. Requiring consumers to own the documentation tooling was rejected because
ADR 0015 defines the Documentation capability as not requiring Node.js, pnpm, or a lockfile
from the consuming repository.

**Lesson.** An empty configuration is a configuration. `{}` reads as "no opinion" and behaves
as "the tool's opinion instead of ours".

## The workflow suites run under Vitest, and `check` no longer runs them

**Decision.** The five `scripts/test-*.mjs` files become Vitest suites under
`tests/integration/`, `pnpm test` runs them, and `pnpm run check` runs formatting, linting,
type checking and the static CI status contract validation only. `pnpm test` aggregates
every offline Vitest project in the workspace, this repository's own suites and the
contract fixtures' alike, with `test:integration` and `test:fixtures` as focused scripts.

**Context.** The previous arrangement broke two active standards at once. The testing
standard puts this repository in scope — it contains executable logic — and requires Vitest
with a fixed `tests/` layout; these were hand-rolled `node:assert` scripts. The git workflow
standard requires a `check` script that runs formatting, linting and type checking and
**must not** run tests; `check` chained five of them.

The tests themselves were never the problem. They install real pinned toolchains, extract
the literal scripts out of the workflow files, and run a real `semantic-release` dry run
against a scratch Git repository — that is what the defects worth catching here need, and
none of it changed. Only the runner, the layout and the script that invokes them did.

`scripts/validate-ci-status-contract.mjs` deliberately stays a script inside `check`. It
asserts that job names in the workflow files match the required status contract: a static
consistency check over repository artifacts, in the same family as `actionlint`, not a
behavioural test.

**Consequences.** `pre-push` now runs the real suites through `pnpm test` rather than
through `check`, and the `workflow and repository checks` job gained an explicit `pnpm test`
step — without it the migration would have silently removed these tests from CI, since
nothing else ran them there. The `release toolchain mechanics` job installs dependencies and
invokes the same suite through Vitest with `RELEASE_TOOLCHAIN_DIRECTORY`, unchanged in
substance. Suites need `allowImportingTsExtensions`, because Vitest resolves TypeScript
itself and the support modules are imported by their real path.

The integration project sets `fileParallelism: false`. `releaseSemverRules` and
`releaseToolchain` both install into `release-toolchain/`, and the second writes generated
configuration files inside it while running; Vitest parallelises test files by default, so
running them as suites introduced a race on shared on-disk state that did not exist while
they were sequential scripts. Serialising the project is the honest fix — the alternative,
giving each suite its own copy of the toolchain, would install the same pinned graph twice
to buy back a few seconds.

Two support artifacts keep extensions the testing standard's suffix table does not list.
`tests/support/fakes/gh.fake.cjs` is copied to an extensionless `gh` executable on a child
process's `PATH`, and an extensionless script only defaults to CommonJS without a sibling
`package.json`; a `.ts` file cannot be executed by Node at all. The package fixtures under
`tests/support/fixtures/` are directory trees whose files are the fixture — a `dist/index.js`
that must be JavaScript on disk. The mandated roots and categories are honoured; only the
extensions differ, because the standard's table describes test _modules_ and has no category
for an on-disk asset that must be executable. Worth raising against the standard rather than
quietly repeating.
