# AI review behaviour

How the [AI review actions](../ai-review) behave, as observed in the pilot in
`Mikode13/slop-lab` before they moved here. The README's
[AI review](../README.md#ai-review) section covers adopting them; this document covers what a
reviewed pull request sees. The caller pins both actions to the same commit; their source is
the authority when this text and the implementation disagree.

## Frozen configuration

A reviewer that changes while it is measured proves nothing, so these are fixed in each
revision of [the actions](../ai-review). A change is a reviewed pull request here:

| Choice           | Value                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Reviewer command | `@mikode13/harness-cli@1.1.0`, with the prompt passed through `--prompt-file`                 |
| Review skill     | `mikode-review` from `Mikode13/skills` at `e62054e`, release 1.0.1                            |
| Provider         | Claude, on a MiKode-owned account, through `CLAUDE_CODE_OAUTH_TOKEN`                          |
| Model and effort | `opus` at `high` reasoning effort                                                             |
| Provider timeout | 15 minutes per turn, enforced by the runner                                                   |
| Repair attempts  | At most one additional turn to recover a reply that failed contract validation                |
| Evidence budget  | 1,250,000 bytes of prompt, about 500,000 tokens, filled in priority order and never truncated |
| Cost ceiling     | The EUR 30 per month the standard allows for the whole provider account                       |
| Policy           | The standards of `Mikode13/engineering` at the commit the workflow pins                       |

Since [Mikode13/engineering#41](https://github.com/Mikode13/engineering/pull/41), the standard
describes `harness-cli` and the merge rules the reviewer follows. ADR 0017 needed no change: it
leaves provider, runtime, and severity rules to the standard.

The pinned policy now includes
[ADR 0018](https://github.com/Mikode13/engineering/blob/main/adr/0018-require-project-owned-architecture-documentation.md),
so the documentation standard the reviewer reads requires `docs/architecture.md`. A repository
that has none, or whose document materially contradicts the project, receives a blocking
finding; wording drift with no architectural consequence does not. The
[architecture review skill](https://github.com/Mikode13/skills/blob/main/skills/mikode-architecture-review/SKILL.md)
the prompt already carries is what applies it. Add that document to a repository before moving
its caller to this revision.

## What runs

The review runs for an internal, non-draft pull request targeting `main` when the pull request
is opened, reopened, marked ready, or receives a new commit. It is triggered by
`pull_request_target`, so GitHub runs the workflow as it is on `main`, never as the pull
request defines it, and only such a run can read the `ai-review` environment that holds the
provider token. A per-pull-request concurrency group cancels superseded executions, so a new
commit discards the result of the previous one. Analysis starts only after `CI / required`
succeeds for the same head commit. When that check fails or does not finish within ten
minutes, the review stops without calling the reviewer, and its summary says why. A pull request
that conflicts with `main` stops it at once, because GitHub runs no CI on it.

The work is split across jobs that do not share credentials:

| Job       | Credentials                                                    | Responsibility                                                               |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Analyze` | Provider token from `ai-review`, read-only GitHub token        | Collect evidence and earlier findings, run the reviewer, validate the result |
| `Publish` | GitHub token with `pull-requests: write` and `statuses: write` | Revalidate, comment findings, update the summary, report the status          |

`Analyze` checks out the pull request head without persisted Git credentials and reads it as
data: nothing from it runs, and the reviewer starts in a separate work directory. The
reviewer's progress output, which the pull request can influence, is printed with workflow
commands switched off. The reviewer's own scripts come from the pinned commit of `Mikode13/.github`,
and the repository instructions, the architecture document, and the decision
log are read from the base revision, so a pull request cannot rewrite the reviewer that is
about to judge it. The base revision is the commit of `main` the caller was read from, not the
base commit recorded in the pull request, which can be older. The reviewed diff starts where the pull request diverges
from it. The review skill comes from the pinned skills revision and applicable standards from
the pinned `Mikode13/engineering` commit, which is recorded in the review input.

`Publish` re-runs the full contract validation on the result it receives before it acts on it,
and neutralizes mentions, HTML, and comment markers in every string it renders. Under
`pull_request_target`, `GITHUB_SHA` is the latest commit of `main` rather than the reviewed
commit, so the job reports the outcome explicitly, as the commit status
`AI Review / required` of the reviewed commit.

### Reviewing this repository

This repository uses [its own caller](../.github/workflows/ai-review-self.yml) to review
non-draft internal pull requests to `main`. The caller runs from `main` under
`pull_request_target` and pins both actions to the same immutable commit. Its analysis job
uses the protected `ai-review` environment, whose deployment branches are restricted to
`main`; its publication job has no provider token. Store `CLAUDE_CODE_OAUTH_TOKEN` as an
environment secret in this repository before activating the caller. A repository or
organization secret can be read by untrusted branch workflows and must not be used here.

The caller can run only after this workflow is merged to `main`. Both actions pin the
merged commit of the actions pull request. When moving the pins after another squash merge,
use the resulting commit on `main`. Then create or update a separate, non-draft test pull
request to trigger a real review. The `AI Review / required` commit status is advisory until
GitHub can require it from a source a branch cannot impersonate. Keep it out of the shared
`required-ci` ruleset; the review conversations still require resolution.

## Evidence, not a workspace

The reviewer receives one prompt and explores nothing. Two properties of the runtime make
that the only reliable design:

- a run without `--auto-approve` has nobody to grant a tool permission, so a request to run a
  command stalls until the deadline instead of failing; and
- `@mikode13/harness` caps a Claude turn at three turns, which is not an exploration budget.

So the analysis job collects the diff, the reviewed files, the pull request description, the
closing issue, the trusted base context, and the applicable standards, and inlines them. Every
section is added whole, in priority order, until the budget is spent; nothing is ever
truncated. What did not fit is declared to the reviewer as a missing source and republished in
the summary under "Context not supplied to the reviewer", which the contract expects it to turn
into reduced coverage rather than a silent pass.

From the pinned skills revision, the prompt carries `mikode-review` and its contract, the three
specialist skills it coordinates, and `mikode-code-philosophy`, whose criteria the code
specialist applies. MiKode policy reaches the reviewer as the Active standards above, in place
of `mikode-context`, which the review skill accepts. The skills' validation cases and the
specialists' calibration examples are left out, because the skills reserve them for
validating the skills rather than for ordinary reviews.

The prompt also shows one example of every object in the result, generated from the
validator and tested against it. Given only the contract's prose, first replies kept adding or
dropping fields, such as `checked_sources` on every recheck. It also tells the reviewer to keep
finding IDs out of anything a person reads, except as the `F1:` prefix that moves a follow-up
item into that finding's comment.

Dropping the trusted `AGENTS.md` or the reviewed files leaves nothing worth reviewing, and so
does supplying a reviewed file only in part, so a reviewed file over 40,000 bytes counts as
missing too. Either way the run is abandoned as `incomplete` before the provider is called
rather than after it returns a vague one.

Lockfiles and `docs/decisions.md` are the exceptions. A changed lockfile is reviewed through
its diff, which shows every package and version that moved; its full resolution graph adds
size without review value. The decision log's diff shows the changed decision, and its
trusted base is supplied separately when it fits the prompt budget. Neither changed file is
supplied whole or counts as oversized. Other Markdown and workflow files still need their
full reviewed content, since their unchanged context can affect the change. An untouched
lockfile costs nothing, because only the files a pull request changes are supplied.

The prompt reaches `harness-cli` as a file through `--prompt-file`, so the model sets its size
rather than the command line. The 1,250,000-byte budget is about 500,000 tokens at the roughly
2.5 characters per token that Anthropic documents for the current tokenizer. That is half of
Opus 5's 1M-token window: it leaves room for the agent's own prompt and the reply, and it
stays below the length at which a long context starts to degrade the review. The report records
the tokens `harness-cli` returns, but that figure cannot confirm the ratio yet: `harness` counts
only uncached input, so the first real review reported 2 input tokens for a 143,506-byte
prompt.

Measured against the pinned skill and the current standards:

| Change                                                           | Prompt  | Result              |
| ---------------------------------------------------------------- | ------- | ------------------- |
| The three-file documentation change in `slop-lab` pull request 1 | 114 KiB | Everything supplied |
| The eight-file bootstrap in `slop-lab` pull request 2            | 250 KiB | Everything supplied |

Until `harness-cli` 1.1.0 the prompt was a single command argument, which Linux caps at
128 KiB. That refused `slop-lab` pull request 2 before the provider was called, so the limit was removed
where it lived, in [harness-cli#7](https://github.com/Mikode13/harness-cli/issues/7), rather
than designed around here.

## Outcomes

Among findings, only a `BLOCKER` fails the check. Its severity comes from the harm it describes,
so it fails the check whether or not the change introduced it.

| Outcome       | Check                           | What it means                                                       |
| ------------- | ------------------------------- | ------------------------------------------------------------------- |
| `blocked`     | `AI Review / required` fails    | At least one `BLOCKER`                                              |
| `concerns`    | `AI Review / required` succeeds | A `SHOULD FIX` of the change, and no `BLOCKER`                      |
| `suggestions` | `AI Review / required` succeeds | Only `SUGGESTION` findings of the change                            |
| `clean`       | `AI Review / required` succeeds | Nothing to change, though findings outside the change may be listed |
| `incomplete`  | `AI Review / required` fails    | No review that can be trusted; the gate blocks until one completes  |

Every `SHOULD FIX` and `SUGGESTION` of the change opens a conversation, and the `main-baseline`
ruleset requires every conversation to be resolved before a merge, so each one holds the merge
until a person reads and resolves it. The comment says what resolving it takes. A `SHOULD FIX`
is resolved only after fixing it in the code or opening an issue that tracks it, and a
`SUGGESTION` can be resolved once read, with or without a change. A finding that is wrong is
resolved with a reply that says why. Nothing checks those conditions yet.

A provider failure, a timeout, a reply that fails contract validation twice, a result bound to
another commit, a result too large to hand between jobs, an analysis job that did not succeed,
and a result that does not recheck every earlier finding all produce `incomplete`.

Each execution decides the status from its own result, never from what is already on the pull
request, so a retry after an `incomplete` review publishes its own result. Publishing the same
report again writes nothing, because every comment carries the key of its finding. To retry,
use "Re-run all jobs": re-running only the failed jobs publishes the same report again without
a new review.

The reasons a reply failed contract validation go to the job log and the review report, even
when the repair succeeds, because they show which part of the contract a first reply gets
wrong. Each reason names the fields that are missing or not in the contract, so the repair
knows what to change. When the repair fails too, the pull request is told only that the reply
did not satisfy the contract. A review of `slop-lab` pull request 6 took 584 seconds of a 600-second turn,
so each turn now has fifteen minutes.

## Findings on the pull request

A finding appears where a person reviewing by hand would put it:

| Finding                                                          | Where it appears                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| A `BLOCKER`, or any finding of the change, on a line of the diff | A comment on that line, which opens a conversation      |
| The same, about a whole file of the diff                         | A comment on the file's first changed line that says so |
| The same, about a line GitHub cannot comment on                  | The summary, with its reasoning                         |
| A finding outside the change, below `BLOCKER`                    | One line in the summary for a maintainer to triage      |

The summary is one pull request comment that every later review updates in place. It holds the
outcome, the blocking findings, what could not go on a line, the reviewer's questions and
limitations, and the context the reviewer did not receive. A review that ends without a valid
result still lists the findings the previous summary held, as that review described them. How
each perspective was reviewed, each recheck, and why a reply was rejected go to the job
summary.

Each review covers the whole pull request, from where it branched off `main` to its latest
commit. Before a later review, the analysis job collects every finding earlier reviews
published: those with a conversation, open or closed, and those the summary lists. The reviewer
rechecks each one against the new commit. Checking a named finding is more reliable than
expecting to discover it again, so a finding the reviewer does not find again is not taken as
fixed:

- **Still present:** no new comment. If the commented code moved, one reply in the open
  conversation says where it is now. A `BLOCKER` whose conversation was closed still blocks,
  and the summary says so. A suggestion someone resolved that is found again as a `SHOULD FIX`
  or `BLOCKER` has its conversation reopened once, with a reply that says so.
- **Looks fixed:** one reply in an open conversation says why, and the conversation stays open
  for a person to close. A finding without a conversation is named in the summary once, then
  dropped.
- **Cannot be decided:** named in the summary and rechecked next time. An earlier `BLOCKER`,
  or an earlier finding that never had a severity, that cannot be decided makes the review
  `incomplete`.

Apart from reopening a resolved suggestion that got worse, the publisher never resolves, reopens,
or deletes a conversation. Whether a conversation was closed is not given to
the reviewer either: it is a decision about the pull request, not
evidence about the code. The reviewer receives only what the earlier review wrote, fenced like
any other reviewed content.

## Known limitations

- A pull request from a fork is not reviewed. `pull_request_target` would let its run read the
  environment, so `Analyze` refuses a fork before it starts and `Publish` reports a failing
  status; the reviewer assumes same-repository branches.
- A reviewed file over 40,000 bytes, other than a lockfile or `docs/decisions.md`, makes the
  run `incomplete`. The decision log is reviewed through its diff and trusted base.
- The runner does not normalize intent. It supplies the closing issue and the description and
  asks the reviewer to resolve the change contract itself, rather than guessing which prose is
  an acceptance criterion.
