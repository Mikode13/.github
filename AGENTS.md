# AGENTS.md

## What this repository is

`Mikode13/.github` owns the organization's GitHub-supported defaults and the reusable
workflows every other MiKode repository calls:

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) implements the
  [continuous integration standard](https://github.com/Mikode13/engineering/blob/main/standards/continuous-integration.md)
  as independently composable capabilities.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) implements the
  [automated npm publication standard](https://github.com/Mikode13/engineering/blob/main/standards/automated-npm-publication.md).
- [`profile/README.md`](profile/README.md) is the organization profile.

It is a private, unpublished repository. Nothing here is installed by a consumer.

## Constraint specific to this repository

Every consuming repository pins a full commit SHA of these workflows. A change here does
not reach anyone until they deliberately move that pin, and a mistake reaches everyone who
does. Two things follow:

- **Compatibility is not optional.** A caller on an older pinned revision must keep
  working exactly as it did. Never repurpose an input or change what a capability means
  within a revision.
- **The executable contract and its documentation live in the same commit.** A capability
  that `README.md` describes but the pinned revision does not implement is worse than an
  undocumented one.

## How this repository is validated

```sh
pnpm install --frozen-lockfile
pnpm run check   # formatting, linting, type checks, and every offline workflow test
pnpm test        # the fixture suites
```

`pnpm run check` runs the workflow tests under `scripts/`. They are deliberately real:
they install the actual pinned toolchains and execute the actual scripts extracted from
the workflow files rather than hand-copied duplicates, because the defects worth catching
here live in how real tools compose, not in logic a unit test could isolate.

Pull requests additionally run `actionlint` and exercise every retained profile and
capability through the reusable workflow itself, in `validate-workflows.yml`. A fixture
job is the only thing that proves a workflow change actually works; the offline scripts
cannot invoke a real action.

### Hazards

- A step that resolves tooling at run time (`pnpm dlx`, `pnpm add`) has no lockfile and
  therefore no reproducibility. Both toolchains exist to avoid exactly that; see
  [`docs/decisions.md`](docs/decisions.md).
- Neither toolchain is a workspace member. Install them with `--ignore-workspace`, and do
  not add them to `pnpm-workspace.yaml`: their graphs are frozen on purpose.
- `actions/checkout` refuses a `path` outside `GITHUB_WORKSPACE`, which is why both
  toolchains are checked out into the consumer's tree and immediately moved to
  `runner.temp`. The move is also what keeps toolchain files out of a consumer's own
  Markdown scan and published tarball.
- A capability must not silently redefine what another one already means. Formatting is
  owned by `@mikode13/code-style`, wherever it runs.

## Engineering standards

This repository follows the active standards in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering/blob/main/standards/README.md).
Do not duplicate their content here; read them there when a change touches package
management, code quality, formatting, git workflow, testing, publication, or CI.

## Releases

This repository is not published to a registry. Its releases are commit SHAs recorded in
the known-good table in [`README.md`](README.md), which consuming repositories pin.
