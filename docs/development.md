# Development

## Container mounts and machine-specific paths

The base compose file mounts what the repository owns: `config.yaml`, `.pi/agent`, `data/` and `work/`.
Anything naming a path on your machine goes in an untracked `docker-compose.override.yml` beside it, which
compose merges by itself. The variables it consumes, all set in `.env`:

| variable | what it points at |
| --- | --- |
| `AGENT_DIR_HOST` | the directory holding the review agent definition, bound at its own host path so one `agent.agentDir` value is right inside and outside the container |
| `SKILLS_HOST` | the skills the review standard is written in, bound at `/skills`; set `agent.skillsDir: /skills` to use them |
| `SKILLS_CACHE_HOST` | the store those skills are symlinked into, needed at the same absolute path or the skills mount dangles |
| `MODELS_JSON_HOST` | a `models.json` kept outside the repository, mounted read-only instead of copying credentials in |

`LAIDBACK_AGENT_NAME` and `LAIDBACK_AGENT_DIR` pass through as environment variables, for a machine that
would rather not name the agent in a config file. The container gets no host credentials, no kubeconfig, and
no Docker socket; the only writable mounts are `data/`, `work/` and the MCP OAuth cache.

`.env` is read by compose through `env_file`, and the paths written in its container section
(`LAIDBACK_CONFIG=/app/config.yaml`, `/data`, tmpfs `/tmp`) only exist inside the image. Nothing on the host
reads `.env`, so a host-side run means exporting the variables yourself and pointing `LAIDBACK_CONFIG` at a
local file. That is why `npm run gate:check:docker` and `npm run gate:check:telegram:docker` are the forms
that work without edits.

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

Working notes for the pieces that were designed rather than coded live beside this file: `PLAN.md` (the
original design), `VERIFY.md` (what was checked against a live PR), `SLOT-PLAN.md` (sharing one inference
server), `LAB-PLAN.md` and `lab/` (the disposable environment), and `FINDINGS-144.md` (a review round's
findings). They are notes, not specification.

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
