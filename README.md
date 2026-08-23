# MiKode GitHub configuration

This repository contains MiKode's public organization profile, shared community health
files, and centralized GitHub Actions workflows.

## Organization profile

The profile shown on the organization page lives in [`profile/README.md`](profile/README.md).

## Reusable continuous integration

The reusable workflow at [`.github/workflows/ci.yml`](.github/workflows/ci.yml) implements
the [MiKode continuous integration standard](https://github.com/Mikode13/engineering/blob/main/standards/continuous-integration.md).
It exposes three repository profiles:

| Profile   | Required project scripts      | Optional capabilities |
| --------- | ----------------------------- | --------------------- |
| `node`    | `check`, `test`               | `build`, `test:e2e`   |
| `package` | `check`, `test`, `pack:check` | `build`, `test:e2e`   |
| `docs`    | `docs:check`                  | None                  |

The workflow always produces an aggregate job named `required`. A thin caller names its
reusable-workflow job `CI`, which gives the organization ruleset the stable status context
`CI / required`.

Project scripts own validation behavior; the workflow owns platform orchestration. It
installs dependencies with the frozen pnpm lockfile, tests supported Node.js versions,
validates pull request metadata through `@mikode13/git-hooks`, and fails the aggregate job
when an applicable dependency fails, is cancelled, or is unexpectedly skipped.

### Caller contract

A repository caller must:

1. Run on pull requests targeting `main` and pushes to `main`.
2. Grant only `contents: read` unless a documented capability needs more.
3. Cancel superseded pull request runs through a per-pull-request concurrency group.
4. Pin this repository's reusable workflow to a full commit SHA.
5. Select the smallest applicable profile and explicitly enable build or end-to-end
   capabilities when they exist.

The organization template at [`workflow-templates/ci.yml`](workflow-templates/ci.yml)
starts with the publishable-package profile. Before committing a generated caller, select
the applicable profile, remove `run_build` when the project has no build script, and
enable `run_e2e` only when the application exposes that capability.

### Known-good workflow releases

| Release | Reusable workflow SHA                                                                                                             | Validation                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial | [`78523ec52c5a598be22e8682cee47409bbe9b4a5`](https://github.com/Mikode13/.github/commit/78523ec52c5a598be22e8682cee47409bbe9b4a5) | [Default-branch CI](https://github.com/Mikode13/.github/actions/runs/32670985582) |

Callers pin the full SHA from this table. The next validated release becomes the new
default template reference, while the preceding entry remains the immediate rollback
target.

## Developing the workflows

The repository validates workflow syntax and exercises every supported profile with
contract fixtures:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
```

Pull requests additionally run actionlint and the `node`, `package`, and `docs` fixtures
through the reusable workflow itself. The outer `required` job covers all of those checks.

## License

This repository is source-available under the MIT License with the Commons Clause License
Condition v1.0. See [`LICENSE`](LICENSE) for the complete terms.
