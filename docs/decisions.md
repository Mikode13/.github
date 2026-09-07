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
