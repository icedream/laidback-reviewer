/**
 * The Telegram gate end to end against a stand-in Bot API.
 *
 * What is pinned here is what a decider actually experiences: the message and its buttons, what a tap
 * does to the stored gate, who is allowed to tap, and that a tap is read exactly once.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGate, renderGateSummary } from "../../src/gate/gate.mjs";
import { createTelegramGate } from "../../src/gate/telegram.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { createTelegramFake } from "../fakes/telegram.mjs";

function telegramCfg(overrides = {}) {
  return {
    reviews: { dryRun: false },
    gate: {
      channel: "telegram",
      beforeReview: false,
      beforePost: true,
      timeoutHours: 24,
      onTimeout: "hold",
      maxPending: 5,
      telegram: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        chatIdEnv: "TELEGRAM_CHAT_ID",
        chatId: "",
        allowUsersEnv: "LAIDBACK_TELEGRAM_USERS",
        timeoutMs: 5_000,
        maxFindingButtons: 8,
        rerunButton: true,
        notify: true,
      },
      ...overrides,
    },
  };
}

const composed = {
  verdict: "request_changes",
  action: "submit",
  event: "REQUEST_CHANGES",
  decisions: ["request_changes: submit"],
  payload: {
    body: "one thing blocks this: go.mod:7 carries the old pin",
    comments: [
      { path: "go.mod", line: 7, body: "the pin is below main, which already carries x/net 0.60" },
      { path: "internal/server/server.go", start_line: 40, line: 44, body: "no test for the customer id filter the ticket asks for" },
    ],
  },
  proposalBody: "",
  proposalBlocking: [],
};

async function fixture({ allowUsers = ["4242"], overrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-telegram-"));
  const telegram = createTelegramFake();
  const apiBase = await telegram.start();
  const store = openStore(path.join(dir, "state.db"));
  const cfg = telegramCfg(overrides);
  const gateTransport = createTelegramGate({ cfg, store, token: telegram.token, chatId: "4242", allowUsers, log: () => {}, apiBase });
  const gate = createGate({ cfg, store, transport: gateTransport, log: () => {} });
  const reviewId = store.saveReview({ owner: "acme", repo: "svc", pr: 71, head_sha: "c81a11a4", composed, dryRun: false, notes: [] });
  const summary = renderGateSummary({
    pr: { html_url: "https://github.com/acme/svc/pull/71" },
    headSha: "c81a11a4",
    composed,
    notes: [],
    decisions: composed.decisions,
  });
  const opened = await gate.open({
    stage: "before_post",
    reviewId,
    summary,
    target: { owner: "acme", repo: "svc", pr: 71, head_sha: "c81a11a4" },
    requestTs: "2026-10-22T09:44:08Z",
  });
  return { dir, telegram, store, cfg, gate, gateTransport, reviewId, opened, cleanup: () => { store.close(); telegram.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("a gate arrives as one message with buttons, and its message id is recorded", async () => {
  const f = await fixture();
  try {
    const sent = f.telegram.messages.at(-1);
    assert.equal(sent.parse_mode, "HTML");
    assert.equal(sent.disable_notification, false);
    assert.match(sent.text, /^<a href="https:\/\/github\.com\/acme\/svc\/pull\/71">acme\/svc#71<\/a>$/m);
    assert.match(sent.text, /<b>Model verdict: request_changes/);
    assert.match(sent.text, /<code>go\.mod:7<\/code>/);
    assert.doesNotMatch(sent.text, /Inline comments \(2\)/);
    assert.equal(sent.text.split("\n").filter((line) => /^\d+\./.test(line)).length, 2, "one numbered line per finding");

    const rows = sent.reply_markup.inline_keyboard;
    assert.deepEqual(rows[0].map((button) => button.callback_data), [`ap:${f.opened.gateId}`, `rj:${f.opened.gateId}`, `hd:${f.opened.gateId}`]);
    assert.deepEqual(rows[1].map((button) => button.callback_data), [`fw:${f.opened.gateId}:0`, `fw:${f.opened.gateId}:1`]);
    assert.equal(f.store.getGate(f.opened.gateId).channel_msg_id, String(sent.message_id));
  } finally {
    f.cleanup();
  }
});

test("a tap approves, and the message loses its buttons so nobody taps twice", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    const applied = await f.gateTransport.readDecisions();
    assert.deepEqual(applied.map((entry) => [entry.state, entry.decided_by]), [["approved", "telegram:4242 @decider"]]);
    assert.equal(f.store.getGate(f.opened.gateId).state, "approved");
    assert.deepEqual(f.telegram.toasts, [{ callback_query_id: f.telegram.calls.find((c) => c.method === "answerCallbackQuery")?.payload.callback_query_id, text: "approved" }]);

    const edited = f.telegram.messages.at(-1);
    assert.match(edited.text, /<b>approved<\/b> by telegram:4242 @decider$/);
    assert.deepEqual(edited.reply_markup.inline_keyboard, [], "the keyboard is cleared");

    // A second tap on a stale message is refused, and the decision is not rewritten.
    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    assert.deepEqual(await f.gateTransport.readDecisions(), []);
    assert.equal(f.telegram.toasts.at(-1).text, "already decided");
    assert.equal(f.store.approvedUnpostedReviews().includes(f.reviewId), true, "the approved review is queued for posting");
  } finally {
    f.cleanup();
  }
});

test("a tap from someone off the allow list is refused and the gate stays pending", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 9999, username: "passer-by" } });
    assert.deepEqual(await f.gateTransport.readDecisions(), []);
    assert.equal(f.store.getGate(f.opened.gateId).state, "pending");
    assert.equal(f.telegram.toasts.at(-1).text, "not on the allow list");
    assert.equal(f.telegram.edits.length, 0, "a refused tap does not rewrite the message");
  } finally {
    f.cleanup();
  }
});

test("a tap with an empty allow list is accepted, and said out loud in the log", async () => {
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-telegram-open-"));
  const telegram = createTelegramFake();
  const apiBase = await telegram.start();
  const store = openStore(path.join(dir, "state.db"));
  const cfg = telegramCfg();
  try {
    const gateTransport = createTelegramGate({ cfg, store, token: telegram.token, chatId: "4242", allowUsers: [], log: () => {}, apiBase });
    const gate = createGate({ cfg, store, transport: gateTransport, log: (line) => logs.push(line) });
    const reviewId = store.saveReview({ owner: "acme", repo: "svc", pr: 72, head_sha: "aaaa1111", composed, dryRun: false, notes: [] });
    const opened = await gate.open({ stage: "before_post", reviewId, summary: "PR: https://github.com/acme/svc/pull/72" });
    telegram.tap(`rj:${opened.gateId}`, { from: { id: 5, username: "anyone" } });
    assert.deepEqual(await gateTransport.readDecisions(), [{ id: opened.gateId, state: "rejected", decided_by: "telegram:5 @anyone" }]);
  } finally {
    store.close();
    telegram.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a numbered button opens that finding, and back restores the summary", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`fw:${f.opened.gateId}:1`);
    await f.gateTransport.readDecisions();
    const shown = f.telegram.messages.at(-1);
    assert.match(shown.text, /<b>Finding 2 of 2<\/b>/);
    assert.match(shown.text, /<code>internal\/server\/server\.go:40-44<\/code>/);
    assert.match(shown.text, /<blockquote>no test for the customer id filter/);
    assert.deepEqual(shown.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`ap:${f.opened.gateId}`, `rj:${f.opened.gateId}`, `hd:${f.opened.gateId}`], "deciding stays possible from the finding view");

    f.telegram.tap(`bk:${f.opened.gateId}`);
    await f.gateTransport.readDecisions();
    const back = f.telegram.messages.at(-1);
    assert.match(back.text, /Model verdict: request_changes/);
    assert.equal(back.text.split("\n").filter((line) => /^\d+\./.test(line)).length, 2);

    // Reading a finding is not a decision.
    assert.equal(f.store.getGate(f.opened.gateId).state, "pending");
  } finally {
    f.cleanup();
  }
});

test("deciding while a finding is open brings the summary back", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`fw:${f.opened.gateId}:1`);
    await f.gateTransport.readDecisions();
    assert.match(f.telegram.messages.at(-1).text, /<b>Finding 2 of 2<\/b>/);

    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    await f.gateTransport.readDecisions();

    const settled = f.telegram.messages.at(-1);
    assert.match(settled.text, /Model verdict: request_changes/, "the message is the review again, not the finding");
    assert.doesNotMatch(settled.text, /Finding 2 of 2/);
    assert.match(settled.text, /<b>approved<\/b> by telegram:4242 @decider/);
    assert.deepEqual(settled.reply_markup.inline_keyboard, [], "the buttons are gone once decided");
  } finally {
    f.cleanup();
  }
});

test("a tap on a message whose gate is gone is answered, not edited into nothing", async () => {
  const f = await fixture();
  try {
    // The gate row is deleted, which is what a state file reset looks like from a stale message.
    f.store.db.prepare(`DELETE FROM gates WHERE id = @id`).run({ id: f.opened.gateId });
    f.telegram.tap(`bk:${f.opened.gateId}`);
    assert.deepEqual(await f.gateTransport.readDecisions(), []);
    assert.equal(f.telegram.toasts.at(-1).text, "this gate is not here any more");
    assert.equal(f.telegram.edits.length, 0, "no edit is attempted with an empty body");
  } finally {
    f.cleanup();
  }
});

test("the decided gate message becomes the progress display", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    await f.gateTransport.readDecisions();

    assert.equal(await f.gateTransport.status(f.opened.gateId, "<b>Reviewing acme/svc#71</b>\nNow: reviewing"), true);
    const shown = f.telegram.messages.at(-1);
    assert.match(shown.text, /Now: reviewing/);
    assert.equal(f.telegram.messages.filter((m) => m.message_id === shown.message_id).length, 1, "the same message is edited, not a new one posted");

    // Telegram refuses an edit that changes nothing; that is not a failure worth logging.
    const again = f.gateTransport.status(f.opened.gateId, "unchanged-but-not-really").then(() => f.gateTransport.status(f.opened.gateId, "unchanged-but-not-really"));
    assert.equal(await again, true);

    assert.equal(await f.gateTransport.status("00000000", "nowhere"), false, "a gate with no posted message is skipped");
  } finally {
    f.cleanup();
  }
});

test("another pass can be asked for on the gate that holds the composed review", async () => {
  const f = await fixture();
  try {
    const sent = f.telegram.messages.at(-1);
    const rows = sent.reply_markup.inline_keyboard;
    assert.deepEqual(rows.at(-1).map((b) => b.callback_data), [`rr:${f.opened.gateId}`], "the fourth control asks for another pass");
    assert.match(sent.text, /another pass/i, "and the message says so" );

    f.telegram.tap(`rr:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    const applied = await f.gateTransport.readDecisions();
    assert.deepEqual(applied.map((entry) => [entry.state, entry.decided_by]), [["rerun", "telegram:4242 @decider"]]);

    // The proposal it replaces stops waiting for approval, and the head is queued for a fresh pass.
    assert.equal(f.store.getGate(f.opened.gateId).state, "rejected");
    assert.equal(f.store.getGate(f.opened.gateId).reason, "superseded by another pass");
    assert.deepEqual(
      f.store.pendingReruns().map((row) => [row.pr, row.head_sha.slice(0, 8), row.requested_by, row.gate_id]),
      [[71, "c81a11a4", "telegram:4242 @decider", f.opened.gateId]],
    );
    assert.deepEqual(f.store.approvedUnpostedReviews(), [], "the superseded review is not posted behind the new pass");
    assert.equal(f.telegram.toasts.at(-1).text, "another pass requested");
    assert.match(f.telegram.messages.at(-1).text, /another pass requested/);
  } finally {
    f.cleanup();
  }
});

test("a task gate offers no rerun control, because nothing has been composed yet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-telegram-task-"));
  const telegram = createTelegramFake();
  const apiBase = await telegram.start();
  const store = openStore(path.join(dir, "state.db"));
  const cfg = telegramCfg();
  try {
    const gateTransport = createTelegramGate({ cfg, store, token: telegram.token, chatId: "4242", allowUsers: ["4242"], log: () => {}, apiBase });
    const opened = await gateTransport.post("11112222", "PR: https://github.com/acme/svc/pull/9\nReview requested for acme/svc#9 at abc12345: bump");
    assert.ok(opened);
    const rows = telegram.messages.at(-1).reply_markup.inline_keyboard;
    assert.equal(rows.length, 1, "decision row only");
    assert.deepEqual(rows[0].map((b) => b.callback_data), ["ap:11112222", "rj:11112222", "hd:11112222"]);
  } finally {
    store.close();
    telegram.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a message posted without the control gains it, text untouched", async () => {
  const f = await fixture();
  try {
    const posted = f.telegram.messages.at(-1);
    posted.reply_markup.inline_keyboard = posted.reply_markup.inline_keyboard.filter((row) => !row[0].callback_data.startsWith("rr:"));
    const textBefore = posted.text;
    assert.equal(posted.reply_markup.inline_keyboard.length, 2, "an older build posted two rows");

    assert.equal(await f.gateTransport.refreshControls(), 1);
    const after = f.telegram.messages.find((entry) => entry.message_id === posted.message_id);
    assert.equal(after.text, textBefore, "only the keyboard is rewritten");
    const rows = after.reply_markup.inline_keyboard;
    assert.deepEqual(rows.map((row) => row.map((b) => b.callback_data)), [
      [`ap:${f.opened.gateId}`, `rj:${f.opened.gateId}`, `hd:${f.opened.gateId}`],
      [`fw:${f.opened.gateId}:0`, `fw:${f.opened.gateId}:1`],
      [`rr:${f.opened.gateId}`],
    ]);

    // The control that arrived late behaves like the one posted with the message.
    f.telegram.tap(`rr:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    assert.deepEqual((await f.gateTransport.readDecisions()).map((entry) => entry.state), ["rerun"]);
    assert.equal(await f.gateTransport.refreshControls(), 0, "a decided gate is left alone");
  } finally {
    f.cleanup();
  }
});

test("an offset is kept, so a restart does not re-decide a gate", async () => {
  const f = await fixture();
  try {
    f.telegram.tap(`ap:${f.opened.gateId}`, { from: { id: 4242, username: "decider" } });
    assert.equal((await f.gateTransport.readDecisions()).length, 1);

    const reopened = openStore(path.join(f.dir, "state.db"));
    const second = createTelegramGate({ cfg: f.cfg, store: reopened, token: f.telegram.token, chatId: "4242", allowUsers: ["4242"], log: () => {}, apiBase: f.telegram.apiBase });
    assert.deepEqual(await second.readDecisions(), [], "the update was acknowledged the first time");
    reopened.close();
  } finally {
    f.cleanup();
  }
});

test("a Telegram failure leaves the gate queued rather than lost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-telegram-down-"));
  const telegram = createTelegramFake();
  const apiBase = await telegram.start();
  const store = openStore(path.join(dir, "state.db"));
  const cfg = telegramCfg();
  const logs = [];
  try {
    telegram.failNextWith("service unavailable");
    const gateTransport = createTelegramGate({ cfg, store, token: telegram.token, chatId: "4242", allowUsers: ["4242"], log: (line) => logs.push(line), apiBase });
    const gate = createGate({ cfg, store, transport: gateTransport, log: (line) => logs.push(line) });
    const reviewId = store.saveReview({ owner: "acme", repo: "svc", pr: 73, head_sha: "bbbb2222", composed, dryRun: false, notes: [] });
    const opened = await gate.open({ stage: "before_post", reviewId, summary: "PR: https://github.com/acme/svc/pull/73" });
    assert.equal(opened.state, "queued");
    assert.equal(store.getGate(opened.gateId).state, "pending");
    assert.ok(logs.some((line) => /could not be posted to Telegram: telegram sendMessage: service unavailable/.test(line)), logs.join("\n"));
    assert.ok(logs.some((line) => /could not be presented in telegram and stays queued/.test(line)));

    // The next cycle reads decisions without a posted message, and nothing throws.
    assert.deepEqual(await gateTransport.readDecisions(), []);
  } finally {
    store.close();
    telegram.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
