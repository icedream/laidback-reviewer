#!/usr/bin/env node
/**
 * Live check of the Telegram gate, without a pull request.
 *
 * Asks the bot who it is, lists the chats it can see (which is how you find your chat id the first time),
 * posts a gate message with its buttons, and polls for a tap. It writes nothing to GitHub and uses a
 * throwaway state file, so approving its message has no effect on a real review.
 *
 *   npm run gate:check:telegram                  posts and waits up to 180s
 *   npm run gate:check:telegram -- --timeout 60
 *   npm run gate:check:telegram -- --discover    list chats and stop
 *   npm run gate:check:telegram -- --chat 123456789
 */

import { loadConfig } from "../config.mjs";
import { createTelegramGate } from "../gate/telegram.mjs";
import { renderGateSummary } from "../gate/gate.mjs";
import { openStore } from "../proposal/store.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cfg = loadConfig();
const telegramCfg = cfg.gate.telegram;
const token = process.env[telegramCfg.botTokenEnv];
const chatId = arg("chat", process.env[telegramCfg.chatIdEnv] ?? telegramCfg.chatId);
const allowUsers = (process.env[telegramCfg.allowUsersEnv] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

if (!token) {
  console.error(
    [
      `${telegramCfg.botTokenEnv} is unset.`,
      "Create the bot with @BotFather, put the token in your password manager, and load it into the environment rather than a file in Downloads.",
      `The chat is ${telegramCfg.chatIdEnv}, or --chat on the command line.`,
    ].join("\n"),
  );
  process.exit(1);
}

if (!allowUsers.length) {
  console.log(`warning: ${telegramCfg.allowUsersEnv} is empty, so anyone who can reach the bot can approve`);
}

// A separate database: this must not mark real gates as decided, nor move the loop's update offset.
const store = openStore(process.env.LAIDBACK_GATE_CHECK_DB ?? "/tmp/laidback-telegram-check.db");
const telegram = createTelegramGate({ cfg, store, token, chatId: chatId ?? "", allowUsers, log: (line) => console.log(`  ${line}`) });

const me = await telegram.call("getMe").catch((error) => {
  console.error(`getMe failed: ${error.message}. The token is wrong or the bot was deleted.`);
  process.exit(1);
});
console.log(`bot: @${me.username} (id ${me.id})`);

const peek = await telegram.call("getUpdates", { offset: 0, timeout_ms: 0, allowed_updates: ["message", "callback_query"] }).catch(() => []);
const chats = new Map();
for (const update of peek ?? []) {
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  if (!chat) continue;
  chats.set(String(chat.id), chat);
}
if (chats.size) {
  console.log("chats the bot can see:");
  for (const [id, chat] of chats) {
    const label = chat.title ?? `${chat.first_name ?? ""} ${chat.last_name ?? ""}`.trim();
    console.log(`  ${id}  ${chat.type}  ${label}`);
  }
}

if (arg("discover", null) !== null) {
  if (!chats.size) console.log("nothing pending: message the bot in the client first, then run this again");
  store.close();
  process.exit(0);
}

if (!chatId) {
  console.error(
    `No chat id. Message the bot once in the Telegram client, run with --discover to read the id, then set ${telegramCfg.chatIdEnv}.`,
  );
  process.exit(1);
}

// Two findings, so the numbered buttons and the finding view are checked as well as the decision row.
const composed = {
  verdict: "request_changes",
  action: "submit",
  event: "REQUEST_CHANGES",
  decisions: ["request_changes: submit (this gate is a check, not a review)"],
  payload: {
    body: [
      "If this reads well, presenting works.",
      "Tap 1 or 2 below to open a finding, then back. Tap approve, reject or hold to decide it.",
      "Nothing here is real, and approving it affects nothing: the row lives in a throwaway state file.",
    ].join(" "),
    comments: [
      { path: "go.mod", line: 7, body: "A single-line finding, so you can see the position written as go.mod:7.\n\nTap back to return to the summary." },
      { path: "internal/api/pagination.go", start_line: 40, line: 44, body: "A range finding: the position is written 40-44, which is how a comment spanning several lines arrives." },
    ],
  },
  proposalBody: "",
  proposalBlocking: [],
};

const reviewId = store.saveReview({ owner: "acme", repo: "example", pr: 1, head_sha: "00000000", composed, dryRun: false, notes: [] });
const summary = renderGateSummary({
  pr: { html_url: "https://github.com/acme/example/pull/1" },
  headSha: "00000000",
  composed,
  notes: ["this gate came from src/cli/telegram-check.mjs"],
  decisions: composed.decisions,
});
const gateId = store.openGate({ kind: "check:telegram", review_id: reviewId, summary });

if (!(await telegram.post(gateId, summary, { reviewId }))) {
  console.error("posting failed; see the telegram line above");
  process.exit(1);
}

const timeoutMs = Number(arg("timeout", "180")) * 1000;
const deadline = Date.now() + timeoutMs;
console.log(`posted gate ${gateId} to chat ${chatId}; waiting up to ${Math.round(timeoutMs / 1000)}s for a tap`);

while (Date.now() < deadline) {
  const held = telegram.leaseHeld?.();
  if (held) console.log(`note: the running bot holds the poll lease (pid ${held.pid}); a decision may land in its cycle instead of here`);
  const applied = await telegram.readDecisions();
  if (applied.length) {
    const gate = applied[0];
    console.log(`decision read: ${gate.state} by ${gate.decided_by}`);
    console.log("reading works: the loop would now post the approved review on its next cycle.");
    store.close();
    process.exit(gate.state === "approved" ? 0 : 2);
  }
  await sleep(3000);
}

console.log("nothing was tapped; the message is still waiting in the chat");
store.close();
process.exit(3);
