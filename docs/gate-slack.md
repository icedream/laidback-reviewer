# Slack as the approval gate

The [gate model](gate.md) is the same whichever channel you pick, and `gate.channel: slack` selects this
one. Slack differs in where you tap. The bot posts the queued summary (verdict mapping, body with banner,
every comment with its path and range) to the channel or DM named by `LAIDBACK_SLACK_CHANNEL`, then reads your
decision from a reaction on that message or from a reply in its thread. A decision is read every
`gate.pollIntervalMs` (10s) while the loop waits between discovery cycles, so a tap starts the work in seconds
rather than at the next `github.pollIntervalMs` (120s). A user token cannot open a DM to itself, so when no
channel id is pinned the target falls back to your self DM and then to a private channel named by
`gate.slack.channelName`.

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

Decide by reacting on the gate message (`:white_check_mark:`, `:x:`, `:hourglass_flowing_sand:`, or
`:arrows_counterclockwise:` for another pass over the head), configured in `gate.slack.reactions`, or in its
thread: `approve <id>`, `reject <id> <reason>`, `hold <id>` or `rerun <id>`. Only allowlisted users count, and
the id is the eight characters shown in the message.

With a bot identity the three decision emoji are seeded on the gate message, so deciding is one click. With a
user token they are not, because the poster and the decider are the same person and the click would clear the
chip instead of setting it; `gate.slack.seedReactions: auto | always | never` overrides that. A reaction from
anyone off the allowlist is ignored.

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
`npm run gate <id> approve`.

A review that failed rather than reached a decision is announced on the same channel as one line with no
buttons, which is what tells you a parked head is parked. Turn that off with `gate.notifyFailures: false`.
