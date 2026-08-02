# MiKode

**Learning software engineering by rebuilding the tools we use.**

MiKode is a public, source-available software engineering lab focused on understanding
what happens beneath the abstractions we use every day.

We build small, focused versions of libraries, developer tools, and AI agent systems; use
them in real projects; and document the decisions, trade-offs, mistakes, and redesigns
along the way.

The goal is not to replace mature projects. It is to understand the problems they solve,
explore their architectural choices, and gradually build a coherent ecosystem of useful,
well-understood tools.

## What we explore

- **Software engineering:** HTTP clients, dependency inversion, dependency injection,
  state management, validation, forms, routing, UI systems, and other reusable libraries.
- **AI-assisted engineering:** agent loops, typed tools, prompts, skills, workflows,
  repository context, observability, and the constraints that make generated work
  reviewable and maintainable.
- **Learning in public:** architecture decisions, alternatives, practical limitations,
  failed experiments, and lessons discovered through real usage.

## How we learn

```text
Understand the problem
        ↓
Build the smallest useful version
        ↓
Use it in a real project
        ↓
Find its limitations
        ↓
Improve the design
        ↓
Document what we learned
```

We optimize for understanding and reliable behavior, not for feature count. A MiKode
project does not need to support every use case; it should provide a clearly defined
subset that behaves predictably.

## Engineering principles

- Learn by building.
- Start with the smallest useful version.
- Prefer explicit behavior over hidden magic.
- Use composition over inheritance.
- Depend on contracts rather than implementations.
- Separate engineering policy from executable tooling.
- Avoid abstraction until real usage reveals the need.
- Test supported behavior and critical paths.
- Record important decisions and their consequences.
- Use AI as a reviewer and accelerator, not as a substitute for understanding.

## The MiKode ecosystem

- **[Engineering](https://github.com/Mikode13/engineering)** — shared standards,
  Architecture Decision Records, policies, and templates.
- **[Skills](https://github.com/Mikode13/skills)** — reusable procedures that help
  humans and agents apply those standards consistently.
- **[Harness](https://github.com/Mikode13/harness)** — an intentionally small agent
  harness for learning how model loops, tools, messages, traces, and workflows fit
  together.
- **Shared tooling** — reusable configuration and workflow packages:
  [code-style](https://github.com/Mikode13/code-style),
  [code-quality](https://github.com/Mikode13/code-quality),
  [tsconfig](https://github.com/Mikode13/tsconfig), and
  [git-hooks](https://github.com/Mikode13/git-hooks).
- **[Fetch](https://github.com/Mikode13/fetch)** — an experimental HTTP client and
  transport-abstraction project.

The intended direction is:

```text
Engineering standards and ADRs
        ↓
Reusable skills and tooling
        ↓
Agent harnesses and libraries
        ↓
Applications that validate them in practice
```

This is a direction, not a fixed architecture. New layers and abstractions are introduced
only when existing projects demonstrate a real need.

## Current focus

MiKode is in its foundation and experimentation phase. The shared engineering baseline is
in place, and the current focus is building the first complete agent-harness vertical
slice: one provider, an explicit agent loop, typed tools, versioned prompts, and complete
execution records.

Libraries and applications will grow alongside it when they provide a concrete way to
test the standards and abstractions in real use.

## Project maturity

> Most MiKode projects are experimental and under active development.

Public APIs may change as projects gain real consumers and better constraints. Stability
is earned through explicit contracts, automated tests, documented limitations,
predictable releases, and practical maintenance experience.

Each repository documents its own license. MiKode software is generally source-available
unless a repository explicitly states otherwise.

## Using AI at MiKode

AI is used extensively, but generated work is not considered correct merely because it
looks plausible. We surround it with clear standards, narrow responsibilities, typed
contracts, tests, quality checks, execution traces, and explicit architectural
boundaries.

> AI may generate anything that we can review, explain, test, and maintain.

## Follow the journey

Explore the repositories, read the decisions, and follow the experiments as they evolve.
Progress will not always be linear: projects may be redesigned, standards may be
superseded, and experiments may be abandoned when they stop teaching us something useful.

That evolution is part of the work.

Contact: [hello@mikode.dev](mailto:hello@mikode.dev)
