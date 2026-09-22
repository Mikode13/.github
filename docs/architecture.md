# Mikode13/.github architecture

This document describes the current architecture of this repository. Why a choice was made
belongs in [`decisions.md`](decisions.md); how to adopt a workflow belongs in
[`README.md`](../README.md); what a reviewed pull request sees belongs in
[`ai-review.md`](ai-review.md). Cross-project policy lives in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering).

## Purpose and scope

This repository owns the automation every other MiKode repository runs: the reusable CI,
release and plugin workflows, the AI review actions, and the organization's GitHub-supported
defaults. It does not own policy, which `Mikode13/engineering` owns, nor the review skills,
which `Mikode13/skills` owns. It implements both.

It is public and unpublished. Nothing here is installed; a consumer names a full commit SHA
of a workflow or an action, and that commit is what runs. The unit of release is therefore a
commit, not a version: there is no build step, no package and no version number for the
repository itself.

## Architectural shape

There is no application here. The repository is four kinds of artifact plus the machinery
that proves they work:

| Artifact                                             | What it is                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.github/workflows/*.yml` with `workflow_call`       | Reusable workflows: CI, release, plugin version, plugin release, superseded AI review |
| `ai-review/analyze`, `ai-review/publish`             | Composite actions, with the repository's only real executable logic beside them       |
| `docs-toolchain/`, `release-toolchain/`              | Dependency graphs frozen by their own lockfiles, installed at run time                |
| `profile/`, `workflow-templates/`                    | Organization-level GitHub content                                                     |
| `fixtures/`, `tests/`, `scripts/`, `ai-review/tests` | This repository's own validation                                                      |

Where logic can live is decided by the artifact, not by how much of it there is. A composite
action runs from a checkout of this repository, so `ai-review/` keeps its behaviour in sibling
ES modules — `build-prompt.mjs`, `collect-earlier-findings.mjs`, `contract.mjs`,
`publish-result.mjs`, `review-state.mjs`, `run-reviewer.mjs` — which lint, type-check and
unit-test like any other source. A reusable workflow cannot read a file from its own defining
repository at run time, so `ci.yml` and `release.yml` embed their scripts deliberately;
embedding is also what makes a caller's pinned SHA guarantee which script ran.

Embedded does not mean untested. `tests/support/fixtures/workflowStep.fixture.ts` extracts a
step's literal `run:` body from the workflow file, so a suite executes the exact text that
ships instead of a hand-copied duplicate that can drift.

## Responsibilities and boundaries

| Component                        | Owns                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`       | Resolving caller inputs into a capability set, running each enabled capability, aggregating `required` |
| `.github/workflows/release.yml`  | Re-verifying release authorization through the API, rebuilding the artifact, publishing through OIDC   |
| `.github/workflows/plugin-*.yml` | Plugin manifest versioning and release for the repositories that distribute plugins                    |
| `ai-review/analyze`              | Waiting for CI, collecting evidence, spending the provider credential, validating the report           |
| `ai-review/publish`              | Re-validating that report, commenting findings, updating the summary, reporting the status             |
| `docs-toolchain/`                | The exact formatter, Markdown linter and link checker the Documentation capability runs                |
| `release-toolchain/`             | The exact `semantic-release` and plugin versions a release runs                                        |
| `validate-workflows.yml`         | This repository's own gate: static checks, one fixture per caller shape, and the aggregate it reports  |

Three boundaries carry the design.

**The reviewer's two actions do not share credentials.** `analyze` holds the provider token
through the caller's protected environment and has write access nowhere. `publish` holds
`pull-requests: write` and `statuses: write` and never sees the token. Neither executes
anything from the pull request: its head is checked out without persisted Git credentials and
read as data. That split is the reason the reviewer is two actions rather than one, and it is
a security boundary before it is a decomposition.

**A capability is resolved once, then obeyed.** `ci.yml` turns inputs — explicit capabilities
or a retained legacy profile — into a capability set in a single `contract` job, and every
other job reads its outputs. Adding a capability means adding an input, a resolution branch
and a job. It never means changing what an existing capability does, because a caller pinned
to an older commit must keep getting exactly what it got.

**The toolchains are deliberately outside the workspace.** Each has its own `package.json` and
lockfile and is installed with `--ignore-workspace`, so a documentation or release run never
resolves fresh transitive dependencies. They are not members of `pnpm-workspace.yaml`, and
adding them would defeat the reason they exist.

## Dependencies and contracts

Dependencies point outward. Nothing here imports from a consuming repository; a consumer
names a commit of this one. Every external dependency is pinned by SHA or exact version: the
policy revision in `Mikode13/engineering`, the skills revision in `Mikode13/skills`, the
`@mikode13/harness-cli` release the reviewer runs, and every third-party action.

The public contracts are:

- **The CI capability inputs**, and the stable status `CI / required` the aggregate job
  reports. A caller job named `CI` is what produces that context.
- **The release caller contract**: a `sha` input, the `npm` environment, and the caller's own
  `id-token: write`. The workflow re-verifies authorization through the API rather than
  trusting what triggered it.
- **The two review action interfaces**, and the commit status `AI Review / required`.
- **The review report object**, defined by `ai-review/contract.mjs`. It is the seam between
  the two review jobs, and both validate it independently — `publish` re-runs the full
  validation on what it receives rather than trusting a job output.

## Important flows

**A consumer's CI run.** The caller invokes `ci.yml` at its pinned SHA. The `contract` job
resolves the capability set and fails a caller that mixes explicit capabilities with the
legacy profile. Each enabled capability runs as its own job on the runtimes the standard
requires, and `required` aggregates them, failing when any applicable dependency failed, was
cancelled or was unexpectedly skipped.

**A review.** `analyze` waits for `CI / required` on the reviewed commit, collects the diff,
the reviewed files, the intent sources and the trusted base context, builds one prompt within
a fixed budget, runs the pinned reviewer, and validates the reply. The report travels to
`publish` as a job output; `publish` re-validates it, writes the comments and the summary, and
reports the status explicitly against the reviewed commit. [`ai-review.md`](ai-review.md)
covers the behaviour in full.

**This repository proving itself.** `validate-workflows.yml` calls `ci.yml` once per caller
shape, each against a miniature real repository under `fixtures/`, and once more over this
repository itself with the Documentation capability, so the documents consumers read to adopt
a workflow get the same structure and internal-link checks that repository gets. Those runs and
the static checks aggregate into its own `CI / required`. A change to the capability contract is
therefore exercised through the real workflow rather than through a description of it, which
is the only thing that can prove a workflow change works: the offline suites cannot invoke a
real action.

## Constraints and trade-offs

- **Compatibility within a revision is absolute.** A change here reaches nobody until they
  move a pin, and a mistake reaches everyone who does. An input is never repurposed and a
  capability never quietly redefined. The executable contract and its documentation ship in
  the same commit, because a capability the README describes and the pinned revision does not
  implement is worse than an undocumented one.
- **The integration suite is slow on purpose.** It installs the real pinned toolchains and
  executes the real scripts taken from the workflow files, because the defects worth catching
  here live in how real tools compose rather than in logic a unit test could isolate. Cheaper
  suites would not prove a workflow change works.
- **Adopting the reviewer through a caller leaves cancellation to the caller.** The documented
  caller cancels superseded runs with `cancel-in-progress: true`. That is available because a
  thin caller, not a ruleset-required workflow, is what reports `AI Review / required`. Should
  the check ever be required from a pinned workflow instead, cancellation has to go — GitHub
  advises against it there — and a superseded run would have to stop itself. That is not the
  current design.
- **The reviewer cannot validate a change to its own configuration.** A pull request here is
  reviewed by the self-caller's pinned revision, which is the revision the change replaces, so
  a claim about the new one is outside what that run can check. The first real check of a
  reviewer change is the next pull request after it merges.
- **The superseded reusable AI review workflow is retained, not supported.** It stays for
  callers still pinned to it; the two composite actions are the adopted path.

The operational hazards a change has to respect — how each toolchain is checked out and moved,
why neither is a workspace member, why the integration project disables `fileParallelism` — are
instructions rather than architecture, and [`AGENTS.md`](../AGENTS.md) owns them.
