/**
 * The throttle, with a clock that can be moved.
 *
 * Telegram counts each rewrite against the per-chat rate limit, so the display must coalesce activity into
 * a few writes a minute and still be certain to land the final outcome.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRunStatus } from "../../src/agent/run-status.mjs";

function harness({ everyMs = 20_000, budgetMs = 1_200_000 } = {}) {
  const sent = [];
  let clock = 1_000_000;
  const status = createRunStatus({
    send: async (text) => sent.push(text),
    title: "Reviewing acme/svc#7",
    everyMs,
    budgetMs,
    now: () => clock,
    startedAt: clock,
  });
  return { sent, status, advance: (ms) => { clock += ms; } };
}

test("activity between writes is coalesced into the next allowed one", async () => {
  const h = harness();
  await h.status.setStage("reading the pull request");
  await h.status.progress({ toolCalls: 1, tokens: 1200, phase: "tool read" });
  await h.status.progress({ toolCalls: 2, tokens: 2400, phase: "tool bash" });
  assert.equal(h.sent.length, 1, "the first write is immediate, the rest wait their turn");

  h.advance(20_000);
  await h.status.progress({ toolCalls: 3, tokens: 3600, phase: "tool grep" });
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /Now: tool grep/);
  assert.match(h.sent[1], /3 tool call\(s\), 3\.6k tokens/);
  assert.match(h.sent[1], /elapsed 00:20 of 20:00/);
});

test("the outcome is written even inside the throttle window, and closes the display", async () => {
  const h = harness();
  await h.status.setStage("reviewing");
  await h.status.finish("review composed", "request_changes, 3 inline comment(s)");
  assert.equal(h.sent.length, 2, "a terminal state is never dropped by the throttle");
  assert.match(h.sent[1], /^<b>Reviewing acme\/svc#7<\/b>/, "the outcome still names the pull request");
  assert.match(h.sent[1], /\n<b>review composed<\/b>/);
  assert.match(h.sent[1], /request_changes, 3 inline comment\(s\)/);

  h.advance(60_000);
  await h.status.setStage("something later");
  assert.equal(h.sent.length, 2, "nothing is written after the outcome");
});

test("a failing status transport is logged, not thrown", async () => {
  const logs = [];
  let clock = 0;
  const status = createRunStatus({
    send: async () => { throw new Error("telegram edit refused"); },
    title: "Reviewing acme/svc#7",
    everyMs: 0,
    log: (line) => logs.push(line),
    now: () => clock,
    startedAt: clock,
  });
  await status.setStage("reviewing");
  assert.deepEqual(logs, ["status update failed: telegram edit refused"]);
});

test("identical text is not rewritten", async () => {
  const h = harness({ everyMs: 0 });
  await h.status.progress({ phase: "thinking" });
  await h.status.progress({ phase: "thinking" });
  assert.equal(h.sent.length, 1);
});

test("a pull request url turns the title into a link", async () => {
  const sent = [];
  let clock = 0;
  const status = createRunStatus({
    send: async (text) => sent.push(text),
    title: "Reviewing acme/svc#7",
    prUrl: "https://github.com/acme/svc/pull/7",
    everyMs: 0,
    now: () => clock,
    startedAt: clock,
  });
  status.note("head 948ed420 on govulncheck/auto-fix");
  await status.setStage("reviewing");
  await status.finish("paused", "the inference server is busy");
  assert.equal(sent.length, 2);
  for (const text of sent) {
    assert.match(text, /^<a href="https:\/\/github\.com\/acme\/svc\/pull\/7">Reviewing acme\/svc#7<\/a>$/m);
    assert.match(text, /head 948ed420 on govulncheck\/auto-fix/);
  }
  assert.match(sent[1], /<b>paused<\/b>/);
});

test("html met a title or stage came from is escaped", async () => {
  const h = harness({ everyMs: 0 });
  await h.status.setStage('bash: rm -rf & echo "<script>"');
  assert.match(h.sent[0], /&lt;script&gt;/);
  assert.doesNotMatch(h.sent[0], /<script>/);
});
