# Telegram as the approval gate

Telegram suits a phone: the bot cannot read reactions in an ordinary chat, so the gate message carries an
inline keyboard, and a tap comes back as a callback query.

```yaml
gate:
  channel: telegram
  telegram:
    botTokenEnv: TELEGRAM_BOT_TOKEN
    chatIdEnv: TELEGRAM_CHAT_ID
    allowUsersEnv: LAIDBACK_TELEGRAM_USERS
    maxFindingButtons: 8
    notify: true            # false posts the gate silently
```

| variable | what goes in it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from [@BotFather]; keep it in your password manager and load it into the environment |
| `TELEGRAM_CHAT_ID` | the numeric chat id. For a DM that is your own user id; a private group has a negative id |
| `LAIDBACK_TELEGRAM_USERS` | your Telegram user id, comma separated. Empty means anyone who can reach the bot can approve |

Create the bot with @BotFather, turn privacy off if it will live in a group (`/setprivacy`), then message
it once (`/start`) so it can see a chat. The chat id is the awkward part, so the check command reads it
for you:

```bash
npm run gate:check:telegram -- --discover   # prints the chats the bot can see
npm run gate:check:telegram                 # posts a gate and waits for a tap
npm run gate:check:telegram -- --chat 123456789 --timeout 60
npm run gate:check:telegram:docker          # the same run inside the image
```

A gate message is one message: the pull request as a link, the verdict line in bold, the review body, and
one numbered line per finding. The numbers are buttons. Tapping one edits the message into that finding's
full text with a back button, which keeps a twelve-finding review readable on a phone screen instead of
spreading it over a dozen thread replies. The decision buttons stay available in the finding view, and the
first decision clears the keyboard so a stale message cannot be tapped twice. A gate the loop withdraws
because its pull request merged is rewritten the same way, and ends on the reason: `withdrawn by harness:
pull request merged at 2026-10-26 08:42Z`. Telegram cuts a message at 4096 characters; a longer summary is
truncated, and every finding stays reachable by number.

Approving a task gate turns that same message into a progress display, because ten silent minutes after an
approval is indistinguishable from a hang. It shows what the session is doing (`tool read path=go.mod`),
how many tool calls and tokens so far, and elapsed time against `reviews.budgetMs`. It ends on the outcome:
`review composed` with the verdict and finding count, `paused` when the inference server is busy and the
head is deferred, or `failed` with the error. Rewrites are throttled by `logging.statusEveryMs`, and a lost
status write never fails a review that is running.

The fourth control, `↻ another pass`, asks for [another pass over the same head](gate.md#another-pass-over-the-same-head);
what it does to the proposal and to the next cycle is described there. Gates that are still waiting get the
current controls when the loop starts, or on demand with `node src/cli/gate.mjs controls`: only the keyboard
is rewritten, the message text stays as it was.

Taps from an id outside `LAIDBACK_TELEGRAM_USERS` are answered with `not on the allow list` and leave the
gate pending. Each callback query is acknowledged as it is read, so a restart does not re-decide a gate.
