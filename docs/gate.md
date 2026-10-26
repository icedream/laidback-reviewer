# The approval gate

A gate is one human decision about one review: a row in the state database, plus a message in whichever
channel you configured. Nothing reaches GitHub while a gate that covers it is unanswered, and the model
cannot open or close one: the harness opens it after the review is composed (or before it starts, if you
ask for that), and only `src/github/poster.mjs` writes afterwards.

```yaml
gate:
  channel: cli            # slack | telegram | cli | none
  beforeReview: false     # hold the task so no tokens are spent before you say yes
  beforePost: true        # queue the composed review for approval before it is sent
  timeoutHours: 24
  onTimeout: hold         # hold leaves it unanswered, skip marks it skipped
  maxPending: 5           # beyond this the queue keeps growing but no new messages are posted
  pollIntervalMs: 10000   # how often the channel is read between discovery cycles
  notifyFailures: true    # a run that died is announced on the channel without a decision attached
```

`channel: none` posts every review the policy allows, and `reviews.dryRun: true` opens no gate at all,
because there is nothing to approve. With a channel that long-polls (Telegram) the tap is read as soon as
the channel releases the connection; otherwise the loop reads every `gate.pollIntervalMs` while it waits,
so a decision lands in seconds rather than at the next `github.pollIntervalMs`.

## What a gate can say

| state | how it gets set | what happens next |
| --- | --- | --- |
| `pending` | opened by the harness | the loop waits |
| `approved` | your decision | a task gate releases that head once; a post gate makes the review eligible to send |
| `rejected` | your decision, or a rerun superseding an older proposal | nothing is posted for that head |
| `held` | your decision | left as you left it: no posting, and no expiry |
| `expired` | `gate.timeoutHours` passed with no decision | `onTimeout: hold` never posts, `onTimeout: skip` marks it skipped |
| `withdrawn` | the pull request merged, closed or disappeared before the pass ran | see below |

A decision can carry a reason (`reject <id> <reason>`), and the reason shows up in the channel message and
in the cycle log.

## One gate per review request

A task gate answers the review request it was opened for, recorded as that event's timestamp. The same
request never gates a head twice, and a newer request is a fresh ask even where an older one was rejected.
An approval is spent rather than kept: the pass that runs on it consumes the gate, and a later cycle that
sees the same head again does nothing.

A pull request that merges or closes stops being a candidate at once, because discovery searches open pull
requests. A task gate queued before that is unconsumable: nothing asks for the head again, and an approval
tapped after the merge would sit there looking like a review that had not started. The cycle settles those
gates before it goes looking for candidates. The row becomes `withdrawn` with the merge time as its reason,
its channel message is rewritten to say the same, and no model time goes to code already in the base
branch. A review composed earlier and waiting on a post gate is left alone, since GitHub still takes a
review on a merged pull request and that pass was already paid for.

## Another pass over the same head

`↻ another pass` on a gate message, or `node src/cli/gate.mjs rerun <id>`, asks for a better review of the
head that produced it. The proposal waiting on that gate is rejected as superseded, so nothing posts behind
the new pass, and the next cycle runs a fresh pass. It starts from the transcript of the pass it replaces
rather than from an empty context, and its findings are handed to the model as a draft to improve on.
`reviews.maxReReviewsPerHead` caps how often, and a head that moved since the request gets the new pass over
the current head rather than the old commit.

## Deciding without the channel

`node src/cli/gate.mjs` works over the state database directly, which is also how you reach a message the
channel no longer shows you:

```bash
node src/cli/gate.mjs list                # gates waiting
node src/cli/gate.mjs show <id>           # the summary as posted
node src/cli/gate.mjs approve <id>
node src/cli/gate.mjs reject <id> [reason]
node src/cli/gate.mjs hold <id>
node src/cli/gate.mjs rerun <id>          # another pass, same as the button
node src/cli/gate.mjs sync                # read decisions from the channel without the loop running
node src/cli/gate.mjs controls            # rewrite the buttons on every waiting message
node src/cli/gate.mjs redraw [id] [limit] # rebuild channel messages from the store
node src/cli/post-approved.mjs <review>   # send an approved review now
```

An approved review is posted by the loop at its next read, re-anchored against the current head rather than
replaying the line numbers the model saw, so a push between composing and approving does not land comments
on the wrong lines.

## Channel pages

- [Slack](gate-slack.md): user token or bot token, reactions, thread commands.
- [Telegram](gate-telegram.md): inline keyboard, finding buttons, the progress display.
