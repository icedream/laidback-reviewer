# laidback-reviewer

A pull-request review bot. It watches for PRs assigned to your GitHub username, runs your review
agent against a checkout, and composes a review: body, inline comments with line ranges, and a
verdict. Whether that verdict reaches GitHub is a configuration decision, not a model decision.


## What it can and cannot do

Can: read assigned PRs, clone and build repositories read-only, run `go test`, `gofmt`,
`golangci-lint`, read Jira and Confluence through the Atlassian MCP, write a review and inline
comments on the PR that triggered it.

Cannot: push a commit, merge, reopen a draft, deploy. Three layers hold that:

1. **Write ceiling.** `src/github/client.mjs` refuses any method that is not a read, and any write that
   is not `POST /repos/<owner>/<repo>/pulls/<n>/reviews`, before the request leaves the process. The
   credential is expected to be a fine-grained PAT with `Pull requests: read and write`,
   `Contents: read-only`, `Metadata/Issues/Checks: read-only`. A repository the token cannot read
   produces a recorded failure against that head and the loop carries on. There is no startup scope
   probe: proving a credential cannot write means attempting a write, which is the thing the check
   would be doing.
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

The base compose file mounts what the repository owns: `config.yaml`, `.pi/agent`, `data/` and `work/`.
Anything naming a path on this machine goes in an untracked `docker-compose.override.yml` beside it,
which compose merges by itself: the review agent directory (`AGENT_DIR_HOST`), the skills the review
standard is written in (`SKILLS_HOST`, bound at `/skills`, so set `agent.skillsDir: /skills`), the
manifest cache those skills are symlinked into (`SKILLS_CACHE_HOST`, needed at the same absolute path or
the skills mount dangles), and a `models.json` kept outside the repository (`MODELS_JSON_HOST`). The
agent directory is bound at its own host path, which keeps one `agent.agentDir` correct in and out of
the container. `LAIDBACK_AGENT_NAME` and `LAIDBACK_AGENT_DIR` pass through as well, for a machine that
would rather not name the agent in a config file. It gets no host credentials, no kubeconfig, and no
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
decision from a reaction on that message (`:white_check_mark:` approve, `:x:` reject,
`:hourglass_flowing_sand:` hold, configurable in `gate.slack.reactions`) or from a reply in the thread:
`approve <id>`, `reject <id> <reason>`, `hold <id>`. With a bot identity the three emoji are seeded on
the gate message so deciding is one click; with a user token they are not, because the poster and the
decider are the same person and the click would clear the chip instead of setting it
(`gate.slack.seedReactions: auto | always | never`). A reaction from anyone off the allowlist is
ignored. A user token cannot open a DM to itself, so the target falls back to the private channel named
by `gate.slack.channelName`.
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

Repositories are settled first. `github.orgs` lists owners, `github.repos` lists `owner/name`
patterns where `*` covers one path segment and `?` one character, and `github.deny` outranks both:

```yaml
github:
  orgs: [example-corp]
  repos: [other-org/runbook]
  deny: [example-corp/secret-*]
```

Names are compared without regard to case, as GitHub resolves them, so a lowercase pattern admits the
display casing the API reports. Everything downstream, including the store key, keeps the casing from
the search hit rather than the one you wrote.

With both allow lists empty the bot reviews nothing, which is the default worth having for a bot that
posts from your own account. `orgs: ["*"]` is the wide setting that takes every repository the token
sees. The filter runs on the search result, before `GET /pulls/N`, so an ignored repository costs one
search hit, no pull fetch and no model time, and the cycle log says why: `skip … matches github.deny
"example-corp/secret-*"`.

The trigger is an individual review request (`review-requested:<you>`), not an assignment. GitHub keeps
the two apart in its data: a request to you appears in `requested_reviewers`, a request to a team you
belong to appears in `requested_teams`, and the timeline event carries `requested_reviewer` or
`requested_team`. No team membership has to be guessed, and `trigger.mode` sets how wide the net is:

- `review_requested` (default): only PRs where you are a named reviewer. Being an assignee too changes
  nothing, and a team-only request is never picked up.
- `assigned`: the older behaviour, `assignee:<you>`, which GitHub also fills from CODEOWNERS.
- `both`: either query, and a PR found by both is reviewed once, on the request.

Provenance is a second axis. The API reports who set the trigger, not why, so `trigger.policy` is a
choice:

- `any` (default): act on it whoever set it.
- `human_actor`: eligible when a person filed the request, whoever wrote the PR; asking yourself
  counts. Skipped only when every request event came from a bot or an organization.
- `exclude_codeowners`: best effort; skip when the trigger landed within five minutes of PR creation
  and a CODEOWNERS rule covering the changed paths names you. Both halves must hold.

The section used to be called `assignment:`. That spelling is still read, translated into `trigger:`,
and named in the startup log rather than dropped.

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

## Sharing one inference slot

A home server runs one prompt at a time, and a request queued behind another still occupies a
connection. Strata keeps reading a prompt body from a client that has stopped sending one, which is how
a paused container left the server `busy: true, generated: 0` for half an hour. So the bot reads the
queue before it adds to it:

| `agent.model.probe` | what it asks |
| --- | --- |
| `status` | Strata's `GET /status`: `{"busy":true,"queued":0,"phase":"reading the prompt"}` |
| `slots` | llama.cpp's `GET /slots?model=<id>`: busy if any slot has `is_processing` |
| `latency` | no status endpoint: one token must come back within `latencyMs` |
| `auto` | tries them in that order and keeps whichever answered |
| `none` | never asks |

Busy means the PR is put aside for `agent.model.deferMs` and the next cycle looks again. That costs no
attempt, so a shared slot never parks a review that was never run; the log says `deferred` rather than
`failed`. A prompt already in flight gets a deadline too: nothing on the wire after
`agent.model.firstTokenMs` while the server shows another prompt in flight means the request is
cancelled and the head deferred. A slow first token on an idle server is left alone, because that is a
large prompt rather than a queue.

Every other outbound call has a deadline as well, because a stalled one holds the cycle silently:
`github.timeoutMs`, `checkout.commandTimeoutMs` for worktree and config calls and
`checkout.transferTimeoutMs` for clone and fetch (with `GIT_TERMINAL_PROMPT=0`, so git fails instead of
asking for credentials it will never get), `toolchain.downloadTimeoutMs` per hop plus
`toolchain.execTimeoutMs` for unpacking, and `gate.slack.timeoutMs`. One review also has a wall clock,
`reviews.budgetMs`; over it the session is cancelled and the head records a failure like any other.

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

Decide by reacting on the gate message (`:white_check_mark:`, `:x:`, `:hourglass_flowing_sand:`), or in
its thread: `approve <id>`, `reject <id> <reason>`, or `hold <id>`. Only
allowlisted users count, the id is the eight characters shown in the message, and an unanswered gate
expires after `gate.timeoutHours`, with `onTimeout: hold` meaning it is never posted. Once you approve,
the next poll cycle posts the review, re-anchored against the current head.

Verify all of it without a pull request:

```bash
npm run gate:check          # auth, channel discovery, a posted message, then waits for your reply
npm run gate:check -- --timeout 60
npm run gate:check:docker   # the same run inside the image
```

The container form is the one that works without edits: `.env` is loaded by compose through
`env_file`, and the paths in that file (`LAIDBACK_CONFIG=/app/config.yaml`, `/data`, tmpfs `/tmp`)
only exist there. Nothing on the host reads `.env`, so a host-side run means exporting the variables
yourself and pointing `LAIDBACK_CONFIG` at a local file.

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

Run the suite inside the image as well, so the runtime the bot actually gets is the one under test:

```bash
npm run test:docker     # builds the image, then mounts tests/ and runs node --test inside it
```

The image carries no compiler: the state store uses Node's built-in `node:sqlite`, so `npm ci` needs
no python or node-gyp. Its toolchain is Node 26 (`NODE_VERSION` build arg; Active LTS from
2026-10-28, with `--build-arg NODE_VERSION=24-slim` for the line maintained to 2028-04-30), Go 1.27.3
with `GOTOOLCHAIN=auto` so a repository declaring a newer Go fetches its own, `golangci-lint` v2.15.0,
and `gh` 2.103.0 with `gh-stack` installed from the extension's release asset, because
`gh extension install` wants a GitHub token that a build has no reason to hold.

`npm run smoke:strata` runs the same fixture with the real `pr-review` agent and skills against your
model and prints the composed review. Structural checks only; the review itself is for you to read.
It reads the fake ticket by default (`--jira fake`); `--jira real` uses the host agent dir's `mcp.json`
and its OAuth cache instead. `--policy hint|submit|drop` picks which verdict shape the printout shows;
the run itself never posts.

Two model calls can collide: the loop and your interactive Pi session share one local inference
server, which holds one prompt at a time. The loop runs one review at a time, re-prompts a busy
endpoint up to `agent.model.busyRetries` times, and spaces failed heads from `reviews.retryBaseMs`
onward.

## Layout

```
src/index.mjs            entry point: config, startup summary, polling loop
src/loop.mjs             the poll cycle: candidates, retry spacing, one review at a time
src/discovery.mjs        assignment search, policies, dedupe
src/review-run.mjs       fetch → session → proposal → policy → gate → post
src/agent/               agent file loading, prompt, tools, guard, session wiring, busy-model retry
src/github/              REST client with the write ceiling, diff anchoring, poster
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
