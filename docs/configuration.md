# Configuration

`config.yaml` is the whole surface; `config.example.yaml` is the annotated copy of every key with its
default. Secrets are never values in it, only the names of the environment variables that hold them, and an
unknown key is rejected at startup rather than ignored.

```bash
cp config.example.yaml config.yaml
cp .env.dist .env                                 # fill in the GitHub token and the gate ids
```

| block | what it decides | detail |
| --- | --- | --- |
| `github` | the token, which accounts and repositories are in scope, how often to poll | [triggering](triggering.md) |
| `trigger` | review request or assignment, provenance policy, drafts | [triggering](triggering.md) |
| `reviews` | what the model may cost, and what a verdict turns into | below |
| `banner` | the disclosure the review carries | below |
| `logging` | progress output, heartbeat, debug decisions | [reviews](reviews.md) |
| `agent` | which review agent and which model, and how to behave when the model is occupied | [environment](environment.md) |
| `context` | whether a second look reuses the first one's session | [reviews](reviews.md) |
| `checkout` | clone or an existing tree, scratch roots, module proxy | [development](development.md) |
| `toolchain` | which `golangci-lint` a review runs | [environment](environment.md) |
| `tools` | bash, MCP servers, and the hosts a review may reach | [environment](environment.md) |
| `lab` | the disposable environment a check may borrow | [environment](environment.md) |
| `gate` | whether a human approves before tokens are spent, and before anything is posted | [the gate](gate.md) |

## What a verdict turns into

```yaml
reviews:
  dryRun: true          # nothing is sent; the payload is printed and stored
  approve: hint         # submit | hint | drop
  requestChanges: hint  # submit | hint | drop
  budgetMs: 1800000     # wall clock for one review; over it the session is cancelled
  maxComments: 25
  maxPerCycle: 2
```

| model verdict | `submit` | `hint` | `drop` |
| --- | --- | --- | --- |
| `approve` | `event: APPROVE` | `event: COMMENT` plus "Verdict: I would have approved this." | `event: COMMENT`, no verdict line |
| `request_changes` | `event: REQUEST_CHANGES` | `event: COMMENT` plus the named blockers | same as above |

An approval from your account can clear a merge gate, and a requested change can block one, so the default
on both axes is `hint`: the review is posted as a comment and the body says what the verdict would have
been. Setting either axis to `submit` is a decision about your own repository's merge policy, not a model
capability.

Failures and retries are configured in the same block, and explained in [reviews](reviews.md):
`maxAttemptsPerHead`, `retryBaseMs`, `retryMaxMs`, `respondToReRequest`, `maxReReviewsPerHead`.

## The disclosure line

```yaml
banner:
  prefix: "Automated review: this pass was written by the repo's review bot."   # intro: opens the body
  suffix: "<sub>This review was performed by a local AI bot.</sub>"      # outro: closes it
  mode: authored           # authored = the review writes both notices; appended = always stitched on
  rephrasePrefix: false    # reword the intro in place, whoever wrote it
  rephraseSuffix: false    # a markup footer stays exactly as configured
```

In authored mode each notice is judged only in its own place: the intro against the opening block of the
body, the outro against the closing block. A review that opens with the outro wording is still asked for an
outro, since one notice does not answer for the other. A body of a single block has no position to judge,
so it is read as a whole.

Carrying a notice means stating it there, not using the configured words: a restatement that keeps the
claims shares few of them by design, and it counts. So a disclosure appears at most once. Where the review
left the place empty the configured sentence is added, and the record says which one was missing. Where the
review wrote its own, or pasted the configured sentence, nothing is added beside it; with rephrasing on,
that block is offered to the model and replaced by one sentence if the rewrite holds up, or left exactly as
the review wrote it if not.

`rephrase` was one flag for both lines; it is now `rephrasePrefix` and `rephraseSuffix`, and the old key
is still translated with a note at startup. With rephrasing on, the rewrite is checked against the
configured text: no new verdict or merge word, no link, no mention, no markup, at most two lines, and some
of the source wording kept. A rewrite that fails any of that is discarded and the configured lines are
used.
