# Composing and posting a review

## The run record

Every run writes a record under `data/reviews/`, named by repository, PR number and head: the proposed
verdict with the reason the model gave, the policy mapping and the GitHub event it turned into, the body and
inline comments as posted, a table of the gates it ran with their evidence, and the harness notes (anchors it
repaired, comments it dropped, the banner it had to add). Nothing in that record reaches GitHub; it is what
the operator reads at the gate.

## What the session is allowed to do

The review writes nothing anywhere. Its tools are `review_propose_body`, `review_propose_comment`,
`review_propose_verdict`, `review_record_gate` and `review_submit`, all of which record a proposal in the
state database. `src/agent/guard.mjs` pattern-matches the shell the session can reach and refuses `git push`,
`gh api` writes, `gh pr merge`, deploy commands, fetches outside `tools.allowHosts`, and reads of credential
files. That layer is intent enforcement: it catches a mistake and the first deliberate attempt, while the
client's write ceiling is the boundary that actually holds.

## Inline comments and anchoring

`GET /pulls/N/files` is the only trustworthy source of where a comment may go. The harness derives the
commentable RIGHT-side ranges from each file's `patch`, drops a comment whose file is not in the diff,
narrows a range that crosses uncommitted lines or hunks to the part nearest the line you pointed at,
and re-reads the head SHA immediately before posting. Repairs and drops are recorded in the run record,
never silently.

## Context reuse

Sessions live in `context.sessionDir`. A run picks up the most relevant session from the last
`context.maxAgeDays` for the same repository: the same PR at an earlier head, then a stack sibling,
then the same branch, then the same ticket key. A session that fits `context.maxForkTokens` is
forked with `SessionManager.forkFrom`; a larger one is carried over as a digest of its findings,
because replaying a long transcript through a local model costs minutes of prompt processing to recover
what the findings row already holds.

## When a run fails

A failed review is recorded against that (PR, head) and retried on a spacing curve: `reviews.retryBaseMs`
doubling up to `reviews.retryMaxMs`, and after `reviews.maxAttemptsPerHead` attempts the head is parked
and left alone until the state is cleared. Without that, one branch that does not build plus a two
minute poll interval is an endless loop that also keeps spending API calls. The startup summary prints
parked heads.

A busy inference endpoint is not treated as a failed run. Transient errors (refused connection,
timeout, 429, 5xx) are retried on the *same session* up to `agent.model.busyRetries` times with
`agent.model.busyBackoffMs` between attempts, and so is a turn that comes back with no review in it:
the session has already read the diff and run the gates, so it is asked to continue rather than start
over. A hard error (context length exceeded, bad tool call) is raised immediately.

## Watching a run

`logging.progress` prints what the session is doing while it does it: each tool call as it starts
(`tool bash command=cd /work/scratch/... && go test ./...`), and a heartbeat during the thinking gaps
(`[03:15] still working: writing, 12 tool call(s)`). `full` adds how each call ended and how long it
took. That is the difference between "the review is running gates" and a terminal that says nothing for
ten minutes.

`logging.level: debug` (or `--debug`, or `LAIDBACK_DEBUG=1`) adds the harness's own decisions: the queue
probe result, the checkout and comparison paths, which linter it settled on, the context it carried
over, and how the policy mapped the verdict. A run that ends early, whether cancelled or failed, stops
its heartbeat and disposes its session, so the process exits instead of printing `still working`.
