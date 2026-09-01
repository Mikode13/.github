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

| Capability      | Current implementation                                           |
| --------------- | ---------------------------------------------------------------- |
| `source`        | `pnpm run check` on Node.js 24                                   |
| `tests`         | `pnpm test` on Node.js 22 and 24                                 |
| `build`         | `pnpm run build` on Node.js 22 and 24                            |
| `package`       | `pnpm run pack:check` on Node.js 24                              |
| `documentation` | Central Markdown formatting, structure, and internal-link checks |
| `end_to_end`    | Playwright browser installation and `pnpm run test:e2e`          |

The catalogue belongs to this immutable workflow revision; future reviewed revisions may add
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

### Legacy profiles

Existing SHA-pinned callers remain compatible with the previous profile contract:

| Profile   | Capability expansion               |
| --------- | ---------------------------------- |
| `node`    | Source + Tests                     |
| `package` | Source + Tests + Package           |
| `docs`    | Documentation                      |

`run_build: true` adds Build and `run_e2e: true` adds End-to-end to compatible legacy
profiles. Callers must use either explicit capability inputs or the legacy profile contract,
not both.

### Caller contract

A repository caller must:

1. Run on pull requests targeting `main` and pushes to `main`.
2. Grant only `contents: read` unless a documented capability needs more.
3. Cancel superseded pull request runs through a per-pull-request concurrency group.
4. Pin this repository's reusable workflow to a full commit SHA.
5. Enable every capability that applies to the repository.

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

## Developing the workflows

The repository validates workflow syntax and exercises both retained profiles and explicit
capability composition with contract fixtures:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
```

The content-only documentation fixture deliberately has no `package.json` or pnpm lockfile.
It verifies the boundary introduced by ADR 0015 rather than simulating project tooling.

## License

This repository is source-available under the MIT License with the Commons Clause License
Condition v1.0. See [`LICENSE`](LICENSE) for the complete terms.
