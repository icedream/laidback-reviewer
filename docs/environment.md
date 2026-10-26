# Runtime environment and integrations

What a review runs against: the inference server it shares with your own session, the disposable environment
it may borrow for a check that needs a live process, the ticket system it reads, and the linter version a
repository pins.

## Running a check that needs a running thing

Some findings cannot be settled by reading: whether a migration applies, whether a daemon really emits the
record the code builds, whether the Dockerfile a change adds actually builds. `lab.enabled` gives the review
somewhere to find out.

```yaml
lab:
  enabled: false
  url: ""                               # the lab daemon, e.g. http://127.0.0.1:9443
  tokenEnv: "LAIDBACK_LAB_TOKEN"
  cpus: 4
  memoryMb: 4096
  diskMb: 20480
  pids: 512
  jobTimeoutMs: 600000
  egress: registries                    # none | registries | open
  concurrency: 1
```

The review reaches it through one tool, `review_lab`, with `build | run | exec | logs | compose | down`. The
shell keeps its refusal of `docker`, `podman`, `kubectl` and friends, so there is one door, and that door
attaches the limits, records the call as a gate row with exit code, duration, image and egress mode, and
reports a failed attempt as `not_run` rather than as silence. The lab has no credentials of any kind, and
nothing in it survives the run.

What runs behind the URL is your decision. The harness only asks for a daemon that takes those limits:
rootless podman under its own user is enough to start with, and a micro-VM per job can replace it later
without changing the tool. `LAB-PLAN.md` in this repository's working notes records the containment tiers,
the egress allow-list, and what is deliberately refused, such as letting the lab reach the bot's network or
credentials.

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
large prompt rather than a queue. An idle server during a quiet run is left alone too: between turns the
harness is assembling tool results and the next prompt has not gone out, so the server sitting on the
counters it finished with says nothing about a stalled request. Only a queue in front of us, or a server
that reports itself busy, had begun generating and then stopped across two looks, cancels a run. A server
reading a large prompt is left alone: the prompt size is published before generation starts, so a paused
counter during a prefill is not evidence of anything, and a request that really never arrives is caught by
`reviews.budgetMs` instead.

Every other outbound call has a deadline as well, because a stalled one holds the cycle silently:
`github.timeoutMs`, `checkout.commandTimeoutMs` for worktree and config calls and
`checkout.transferTimeoutMs` for clone and fetch (with `GIT_TERMINAL_PROMPT=0`, so git fails instead of
asking for credentials it will never get), `toolchain.downloadTimeoutMs` per hop plus
`toolchain.execTimeoutMs` for unpacking, and `gate.slack.timeoutMs`. One review also has a wall clock,
`reviews.budgetMs`; over it the session is cancelled and the head records a failure like any other.

## Ticket access

A review reads the ticket a PR names in its title, body or branch, but only when an MCP server is wired up.
The session loads servers from `mcp.json` in the agent directory, and this repository ships the Atlassian
entry as `.pi/agent/mcp.json.dist`. Nothing is connected until you copy it into place:

```bash
cp .pi/agent/mcp.json.dist .pi/agent/mcp.json
PI_CODING_AGENT_DIR="$PWD/.pi/agent" pi mcp login atlassian
PI_CODING_AGENT_DIR="$PWD/.pi/agent" pi mcp list   # atlassian: connected, 10 tools
```

`mcp.json` is gitignored because it holds per-machine servers and nothing worth publishing. The sign-in
writes `mcp-auth.json` beside it. That is an OAuth credential with `offline_access` in scope, which pi
refreshes in place, so no browser is needed again until the refresh token itself dies. In the container
both files are bind mounts, `mcp.json` read-only and `mcp-auth.json` writable, since a refresh rewrites it:

```yaml
volumes:
  - type: bind
    source: ${PWD}/.pi/agent/mcp.json
    target: /app/.pi/agent/mcp.json
    read_only: true
  - type: bind
    source: ${PWD}/.pi/agent/mcp-auth.json
    target: /app/.pi/agent/mcp-auth.json
```

They live in the override file rather than the base one: a bind whose source is missing becomes a directory,
and `mcp-auth.json` only exists once you have signed in.

An API token in a bearer header is the other shape, and it fails differently than you would expect. It
authenticates, lists your sites as read-write, and then answers every Jira and Confluence read with `You
don't have permission to connect via API token. Please ask your organization admin for access.` Atlassian
gates that endpoint per organisation, so the header route needs an admin to enable it. OAuth does not.

Whichever credential you use, a review run can only read. `getJiraIssue`, `searchJiraIssuesUsingJql`,
`getConfluenceContent`, `searchConfluence`, `getAccessibleAtlassianResources`, `discover` and `executeRead`
pass; `executeWrite`, `executeDestructive`, `execute`, and any comment or issue edit are refused before the
call leaves the process, whatever the credential allows. `tools.mcp: [atlassian]` in config.yaml is what
exposes the server to the model at all.

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
