# laidback-reviewer

A pull-request review bot for one GitHub account. It watches for the PRs where you were asked to
review, runs your own review agent against a real checkout, and composes a review: a body, inline
comments pinned to diff lines, and a verdict. Whether that verdict reaches GitHub is a configuration
decision, and with the gate on, a human one.

The review is not a chat completion over a diff. It is an agent session with the review standard you
wrote, running the repository's own tests and linter in a scratch tree, whose output goes through a
policy layer and optionally a queue you approve before anything is posted.

## Features

- **Discovery by request, not by chance.** A search for `review-requested:<you>` (or
  `assignee:<you>`) since the last cursor, narrowed to the owners and `owner/name` patterns you allow,
  with the issue timeline read to tell a request from a person apart from a CODEOWNERS auto-assign.
- **A real checkout.** A clone plus a detached worktree per review, with the base revision fetched
  alongside so the diff is three-dot and a finding can be labelled introduced or pre-existing.
- **The project's own gates.** `go test`, `gofmt`, and `golangci-lint` at the version the repository
  pins in its workflow, installed into scratch per run rather than baked into the image. A gate that
  cannot start is recorded as `not_run` with the reason instead of blamed on the branch.
- **Anchored comments.** Inline findings carry `start_line` and `line`, narrowed to the ranges GitHub
  accepts for that file, and re-resolved against the current head immediately before posting, so a push
  between composing and approving does not land a comment on the wrong line.
- **A human gate.** Slack, Telegram or the CLI. The queued summary shows the verdict, the policy mapping,
  the body and every comment with its path and range; you answer approve, reject, hold, or another pass
  over the head.
- **A verdict you configure.** `approve: hint` and `requestChanges: submit` are the defaults: an AI
  approval becomes a comment that says what it would have been, and a blocking review posts for real once
  you clear it.
- **A record per run** under `data/reviews/`: the proposed verdict with its reason, the policy mapping,
  every gate with its evidence, the comments as posted, and each anchor the harness had to repair.
- **Carried-over context.** A second look at the same PR, a stack sibling or the same ticket key
  continues the earlier session, forked when it fits the context window and digested when it does not.
- **A disposable environment** for checks that need a running thing: build an image, apply a migration to
  a database, confirm a protocol against a real daemon. One tool, CPU and memory limits, no credentials.
- **A shared inference slot it respects.** Before adding to the queue on a home model server, the bot
  reads it. A busy server defers the head for a while and costs no attempt.

## What it cannot do

It cannot push a commit, merge a PR, mark a draft ready, deploy, or write to your ticket system. Three
layers hold that line. `src/github/client.mjs` refuses any method that is not a read, and any write that
is not `POST /repos/<owner>/<repo>/pulls/<n>/reviews`, before the request leaves the process; the model
has no posting tool at all, only `review_propose_body`, `review_propose_comment`,
`review_propose_verdict`, `review_record_gate` and `review_submit`; and a tool policy
(`src/agent/guard.mjs`) blocks `git push`, `gh api` writes, `gh pr merge`, deploy tools, outbound fetches
outside the allowlist and reads of credential files. The client ceiling is the boundary, the tool policy is
what catches a mistake, and only `src/github/poster.mjs` writes after the policy and the gate.

## Quick start

```bash
cp config.example.yaml config.yaml
cp .env.dist .env                               # the GitHub token and the gate ids
cp .pi/agent/mcp.json.dist .pi/agent/mcp.json   # only if reviews should read Jira
cp ~/.pi/agent/agents/pr-review.md .pi/agent/agents/
cp ~/.pi/agent/models.json .pi/agent/models.json
npm install

node src/cli/review-once.mjs --repo example/orders-svc --pr 143 --dir /path/to/checkout --dry-run
node src/index.mjs                              # the loop
```

In a container, where the mounts and the environment file are already wired for you:

```bash
mkdir -p data work
docker compose build
docker compose up
```

The credential is expected to be a fine-grained PAT with `Pull requests: read and write`,
`Contents: read-only`, and `Metadata/Issues/Checks: read-only`. A repository the token cannot read
records a failure against that head and the loop carries on.

## Configuration in brief

```yaml
github:
  me: octocat                   # review requests are matched against this login
  orgs: [example-corp]          # every repository under these owners
  repos: []                     # or owner/name patterns: [example-corp/orders-*]
trigger:
  mode: review_requested        # only PRs where you are a named reviewer
reviews:
  approve: hint                 # submit | hint | drop
  requestChanges: submit
gate:
  channel: telegram             # slack | telegram | cli | none
  beforeReview: true            # ask before any model time is spent
  beforePost: true              # ask before anything is posted
```

With both allow lists empty the bot reviews nothing, which is the default worth having for a bot that
posts from your own account.

## How a review flows

1. Search for requests since the stored cursor, drop out-of-scope repositories before fetching anything.
2. Dedupe by `(owner, repo, pr, head_sha)`; a force push is a new candidate, a re-request reopens the
   same head up to a configured ceiling.
3. The task gate asks whether the pass may run, if `gate.beforeReview` is on.
4. Clone and detach a worktree at the head, fetch the base for the three-dot diff.
5. Run the agent session: it reads the diff, the ticket, and the repository docs, runs the gates, and
   proposes a body, comments and a verdict through the proposal tools.
6. The policy maps the verdict to a GitHub event and trims comments past `reviews.maxComments`.
7. The post gate holds that composed review until you approve it, unless the channel is `none`.
8. Posting re-anchors against the current head, records the review id, and writes the run record.
9. A failure spaces the head out on a retry curve and parks it after `reviews.maxAttemptsPerHead`.

## Documentation

| page | what it covers |
| --- | --- |
| [Configuration](docs/configuration.md) | every block, the verdict mapping, the disclosure banner |
| [Triggering](docs/triggering.md) | repository scope, review request versus assignment, provenance policies, dedupe and re-review |
| [The gate](docs/gate.md) | stages, states including expiry and withdrawal, another pass, deciding from the CLI |
| [Gate on Slack](docs/gate-slack.md) | user token versus bot token, reactions, thread commands |
| [Gate on Telegram](docs/gate-telegram.md) | inline keyboard, finding buttons, the progress display |
| [Reviews](docs/reviews.md) | anchoring, the run record, context reuse, failure spacing, watching a run |
| [Environment](docs/environment.md) | the shared inference slot, the lab, Jira and Confluence access, linter versions |
| [Development](docs/development.md) | container mounts, the test suite and its fakes, the image toolchain, source layout |

## Status

Implemented: discovery and provenance policies, the review session with proposal tools and tool policy,
anchoring, verdict policy, banner with optional rephrasing, the gate on Slack, Telegram and the CLI,
posting, per-run records, context pickup over persisted sessions, failure spacing and parking, busy-model
retries, withdrawn task gates for pull requests that merged, per-repository linter versions, the lab
client, container setup, fixture integration tests and a live smoke run against a real model.

Not attempted: multi-user deployments, a web UI, non-Go repositories, and any write other than a review
on the pull request that triggered the run.
