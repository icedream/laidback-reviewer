# laidback-reviewer

A pull-request review bot. It watches for PRs assigned to your GitHub username, runs your review
agent against a checkout, and composes a review: body, inline comments with line ranges, and a
verdict. Whether that verdict reaches GitHub is a configuration decision, not a model decision.


## What it can and cannot do

Can: read assigned PRs, clone and build repositories read-only, run `go test`, `gofmt`,
`golangci-lint`, read Jira and Confluence through the Atlassian MCP, write a review and inline
comments on the PR that triggered it.

Cannot: push a commit, merge, reopen a draft, deploy. Three layers hold that:

1. **Token scope.** A fine-grained PAT with `Pull requests: read and write`, `Contents: read-only`,
   `Metadata/Issues/Checks: read-only`. Pushing is refused by GitHub, not by the bot's good intentions.
   Startup proves it: the bot attempts a contents write whose base sha is not an object in any
   repository, so a token that could write answers 422 and a scoped token answers 403, and nothing is
   written either way. A 422 stops the bot from starting. Set `github.probeRepo` to a repository the
   token can see.
2. **No posting tool.** The model has `review_propose_comment`, `review_propose_body`,
   `review_propose_verdict`, `review_record_gate`, `review_submit`. Only `src/github/poster.mjs`
   writes to GitHub, after the policy and the gate.
3. **Tool policy** (`src/agent/guard.mjs`). Blocks `git push`, `gh api` writes, `gh pr merge`,
   deploy tools, outbound fetches outside the allowlist, and reads of credential files. This layer is
   intent enforcement: bash strings are pattern-matched, so it is the layer that catches mistakes and
   the first deliberate attempt, while layer 1 is the boundary that actually holds.

An approval from your account can clear a merge gate, and a requested change can block one, so the
default on both axes is `hint`: the review is posted as a comment and the body says what the verdict
would have been.

## Quick start

```bash
cp config.example.yaml config.yaml
cp .env.dist .env                              # fill in the PAT and the Slack ids
cp .pi/agent/mcp.json.dist .pi/agent/mcp.json   # only if the bot should read Jira
cp ~/.pi/agent/agents/pr-review.md .pi/agent/agents/
cp ~/.pi/agent/models.json .pi/agent/models.json # the model provider you want it to use
npm install

# one PR, dry run, prints exactly what would be sent
node src/cli/review-once.mjs --repo example/orders-svc --pr 143 --dir /path/to/checkout

# the loop
node src/index.mjs
```

In a container:

```bash
mkdir -p data work
docker compose build
docker compose up
```

The container mounts `config.yaml`, `.pi/agent`, `~/.agents/skills` at `/skills` (set
`agent.skillsDir: /skills`), `data/` and `work/`. It gets no host credentials, no kubeconfig, and no
Docker socket.

## Reading the decisions

```yaml
reviews:
  dryRun: true          # nothing is sent; the payload is printed and stored
  approve: hint         # submit | hint | drop
  requestChanges: hint  # submit | hint | drop
```

| model verdict | `submit` | `hint` | `drop` |
| --- | --- | --- | --- |
| `approve` | `event: APPROVE` | `event: COMMENT` plus "Verdict: I would have approved this." | `event: COMMENT`, no verdict line |
| `request_changes` | `event: REQUEST_CHANGES` | `event: COMMENT` plus the named blockers | same as above |

The gate adds a human step:

```yaml
gate:
  channel: slack        # slack | cli | none
  beforeReview: false   # hold the task so no tokens are spent before you say yes
  beforePost: true      # queue the composed review for approval before it is sent
  timeoutHours: 24
  onTimeout: hold       # hold means never post
```

With `channel: slack` the bot posts the queued summary (verdict mapping, body with banner, every
comment with its path and range) to the channel or DM in `LAIDBACK_SLACK_CHANNEL`, and reads your
reply in that thread: `approve <id>`, `reject <id> <reason>`, `hold <id>`. A user token cannot open a
DM to itself, so the target falls back to the private channel named by `gate.slack.channelName`.
`channel: cli` prints the same summary and is decided with `node src/cli/gate.mjs`.

Every run writes a record under `data/reviews/`: gate runs, the policy mapping, and every comment
anchor the harness had to repair.

```yaml
banner:
  prefix: "I'm on leave this week; this review is the bot."
  suffix: "<sub>This review was performed by a local AI bot.</sub>"
  rephrase: false   # one small model call rewrites the two lines for flow
```

With `rephrase: true` the rewrite is checked against the configured text: no new verdict or merge
word, no link, no mention, no markup, at most two lines, and some of the source wording kept. A
rewrite that fails any of that is discarded and the configured lines are used.

## Which PRs trigger it

`assignee:<you>` is already the direct case: GitHub only ever assigns PRs to individual users, and a
team review request (`review_requested` with `requested_reviewer.type: "Team"`) never touches the
assignee list. What the API does not tell you is provenance, so `assignment.policy` is a choice:

- `any` (default): act on the assignment whoever set it.
- `human_actor`: skip when the timeline's `assigned` event actor is a bot or an organization.
- `exclude_codeowners`: best effort; skip when the assignment lands within five minutes of PR
  creation and a CODEOWNERS rule covering the changed paths names you. Both halves must hold.

Dedupe is per `(owner, repo, pr, head_sha)`, so a force push is a new candidate and
`reviews.rereviewOnPush` decides whether it gets reviewed again.

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

## Linter versions

The image ships `golangci-lint` v2, pinned by `GOLANGCI_LINT_VERSION` at build time. That is a floor:
repositories pin their own versions, and a v1 binary cannot read a v2 config at all. With `toolchain.golangciLint: auto` the harness reads the pins from the repository
(CI workflow first, then `.tool-versions`/`.mise.toml`/Makefile), notes the schema version the config
file declares, and installs the pinned release into `toolchain.installDir` without touching the image.
Every hop of the download is checked against `tools.allowHosts`, which is why the example config lists
the GitHub asset CDN as well as `github.com`. Set `golangciLint: off` to use only the image's copy, or
an explicit tag to force one.

A linter that will not start is a tooling gap, not a defect in the branch: the task prompt says so, and
the expected outcome is a gate recorded as `not_run` with the reason. When the pins disagree, the
disagreement is named in the prompt and in the run record.

## Slack as the approval gate

```yaml
gate:
  channel: slack
  beforePost: true      # the composed review waits here for your approval
reviews:
  dryRun: false         # with dryRun nothing is sent, so no gate opens and Slack stays quiet
```

Then four variables, in `.env` (compose loads it through `env_file`):

| variable | what goes in it |
| --- | --- |
| `SLACK_MCP_XOXC_TOKEN` | `xoxc-...` user token, or `xoxb-...` with `transport: botToken` |
| `SLACK_MCP_XOXD_TOKEN` | the matching `xoxd-...` value; required for `xoxc`, harmless otherwise |
| `LAIDBACK_SLACK_USERS` | your Slack user id, comma separated. Empty means anyone in the channel can approve |
| `LAIDBACK_SLACK_CHANNEL` | channel or IM id to pin. Unset, the bot looks for your self DM, then a private channel named `gate.slack.channelName` |

Getting the user token pair: sign in to Slack in a browser, open DevTools, pick any request to
`api.slack.com` in the Network tab, and copy the `xoxc-...` from its `Authorization` header plus the
`d=` cookie value. Both die with the browser session, so expect to refresh them.

A bot token instead: create a Slack app with `chat:write`, `conversations:read`, `im:read`,
`users:read`, and `channels:history`/`groups:history` for the channel it reads replies from, invite the
bot to that channel, and put `xoxb-...` in `SLACK_MCP_XOXC_TOKEN`. A bot can open a real DM; a user
token cannot open your own self DM, which is why the pinned channel id exists.

Decide in the thread of the gate message: `approve <id>`, `reject <id> <reason>`, or `hold <id>`. Only
allowlisted users count, the id is the eight characters shown in the message, and an unanswered gate
expires after `gate.timeoutHours`, with `onTimeout: hold` meaning it is never posted. Once you approve,
the next poll cycle posts the review, re-anchored against the current head.

Verify all of it without a pull request:

```bash
npm run gate:check          # auth, channel discovery, a posted message, then waits for your reply
npm run gate:check -- --timeout 60
```

It writes to a throwaway state file, so approving its message has no effect on real reviews. With
`transport: webhook` the message goes out but nothing can be read back, and the decision is taken with
`npm run gate <id> approve`. More than `gate.maxPending` gates waiting stops presenting new messages and
keeps queueing the reviews in the database.

## Tests

```bash
npm test                     # unit tests plus the fixture flow, no GPU, no network
npm run smoke:strata         # the fixture flow with your real model and agent
```

`npm test` builds a synthetic Go repository (`tests/fixtures/repo.mjs`) with a medium change and
planted defects, serves its real diff through a fake GitHub API (`tests/fakes/github-api.mjs`), serves
the ticket the PR follows through a fake Jira over MCP stdio (`tests/fakes/jira-mcp.mjs`), and drives
the pipeline with a scripted OpenAI-compatible model (`tests/fakes/model.mjs`). The scripted model
stands in for turn shape, not for review quality: it proves the anchors, the policy mapping, the
banner, the gate and the tool policy behave, and it fails the test on any GitHub call outside the
allowlist. It also attempts `git push` from inside the session so the guard's refusal is asserted
rather than assumed, and `mcp__atlassian__addComment` so the Jira read-only rule is asserted the same
way.

`tests/integration/ticket-coverage.test.mjs` covers what a diff cannot show: the ticket has five
acceptance criteria, the branch implements four, and nothing in the diff points at the fifth. The
review that comes out names it.

`npm run smoke:strata` runs the same fixture with the real `pr-review` agent and skills against your
model and prints the composed review. Structural checks only; the review itself is for you to read.
It reads the fake ticket by default (`--jira fake`); `--jira real` uses the host agent dir's `mcp.json`
and its OAuth cache instead. `--policy hint|submit|drop` picks which verdict shape the printout shows;
the run itself never posts.

Two model calls can collide: the loop and your interactive Pi session share one local inference
server, which holds one prompt at a time. The loop runs one review at a time and backs off on a busy
server.

## Layout

```
src/index.mjs            entry point: config, token-scope probe, startup summary
src/loop.mjs             the poll cycle: candidates, retry spacing, one review at a time
src/discovery.mjs        assignment search, policies, dedupe
src/review-run.mjs       fetch → session → proposal → policy → gate → post
src/agent/               agent file loading, prompt, tools, guard, session wiring, busy-model retry
src/github/              REST client, diff anchoring, poster, token-scope probe
src/proposal/            policy mapping, store, run record, failure spacing, re-posting approved reviews
src/gate/                gate interface, Slack transport
src/context/             stack walk, which earlier look to carry over, fork vs digest
src/tools/               golangci-lint pin detection and installation
src/cli/                 review-once, gate, post-approved
tests/                   fixture repository, fake GitHub, fake Jira over MCP, scripted model, integration flow
```

## Status

Implemented: discovery and assignment policies, the review session with proposal tools and tool
policy, anchoring, verdict policy, banner with optional rephrasing, gate (Slack and CLI), posting,
per-run records, context pickup over persisted sessions (stack walk, fork or digest), failure
spacing and parking, busy-model retries, per-repository linter versions, container setup, the
fixture integration tests and the live smoke run.

Not yet: the Atlassian credential strategy inside the container (mount an authenticated
`mcp-auth.json`, or mint a bearer token), a Telegram gate adapter, one live Slack gate run, building
the image to confirm the pinned toolchain installs, and a live run that shows a forked session making
the second review better rather than just cheaper.
