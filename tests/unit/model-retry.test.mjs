/**
 * What the session wrapper does when the inference endpoint misbehaves.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createProposalCollector } from "../../src/agent/tools.mjs";
import { isTransientModelError, promptWithModelRetry } from "../../src/agent/model-retry.mjs";

const cfg = { agent: { model: { busyRetries: 2, busyBackoffMs: 25 } } };

function stubSession({ throws = [], fillOnCall = null }) {
  const prompts = [];
  let calls = 0;
  return {
    prompts,
    async prompt(text) {
      calls += 1;
      prompts.push(text);
      const failure = throws.find((entry) => entry.at === calls);
      if (failure) throw failure.error;
      if (fillOnCall !== null && calls >= fillOnCall) return;
    },
  };
}

test("connection and overload errors count as transient", () => {
  for (const message of [
    "connect ECONNREFUSED 127.0.0.1:8080",
    "read ECONNRESET",
    "this operation was aborted: timeout",
    "upstream returned 503 Service Unavailable",
    "429 Too Many Requests",
    "engine_overloaded: server busy",
    "model provider rate limit exceeded",
  ]) {
    assert.equal(isTransientModelError(new Error(message)), true, message);
  }
  for (const message of ["invalid tool schema", "context length exceeded", "review produced nothing for x/y#1"]) {
    assert.equal(isTransientModelError(new Error(message)), false, message);
  }
});

test("a transient failure re-prompts the same session and counts the retries", async () => {
  const session = stubSession({
    throws: [
      { at: 1, error: new Error("connect ECONNREFUSED 127.0.0.1:8080") },
      { at: 2, error: new Error("503 model server busy") },
    ],
    fillOnCall: 3,
  });
  const collector = createProposalCollector();
  const logs = [];
  const slept = [];

  const retries = await promptWithModelRetry({
    session,
    cfg,
    collector,
    prompt: "Review pull request #143.",
    log: (line) => logs.push(line),
    sleepImpl: async (ms) => slept.push(ms),
  });

  // The failure was written on the first prompt; the collector was filled on the third.
  assert.equal(retries, 2);
  assert.equal(session.prompts.length, 3);
  assert.equal(session.prompts[0], "Review pull request #143.");
  assert.match(session.prompts[1], /Continue the review/);
  assert.deepEqual(slept, [25, 25]);
  assert.match(logs[0], /model endpoint busy \(connect ECONNREFUSED.*\); retry 1\/2/);
});

test("an error that is not transient is raised at once", async () => {
  const session = stubSession({ throws: [{ at: 1, error: new Error("context length exceeded") }] });
  const collector = createProposalCollector();

  await assert.rejects(
    () => promptWithModelRetry({ session, cfg, collector, prompt: "go", log: () => {}, sleepImpl: async () => {} }),
    /context length exceeded/,
  );
  assert.equal(session.prompts.length, 1, "no retry on a hard error");
});

test("a turn that produces nothing usable is continued, then accepted as-is", async () => {
  const session = stubSession({});
  const collector = createProposalCollector();
  const logs = [];

  const retries = await promptWithModelRetry({
    session,
    cfg,
    collector,
    prompt: "go",
    log: (line) => logs.push(line),
    sleepImpl: async () => {},
  });

  assert.equal(retries, cfg.agent.model.busyRetries, "it stops at the retry budget");
  assert.equal(session.prompts.length, 3);
  assert.match(logs.at(-1), /the model turn produced no review after 3 attempt\(s\)/);
});

test("retries exhausted on a persistently failing endpoint raises", async () => {
  const session = stubSession({
    throws: [
      { at: 1, error: new Error("503 busy") },
      { at: 2, error: new Error("503 busy") },
      { at: 3, error: new Error("503 busy") },
    ],
  });
  const collector = createProposalCollector();
  const logs = [];

  await assert.rejects(
    () => promptWithModelRetry({ session, cfg, collector, prompt: "go", log: (line) => logs.push(line), sleepImpl: async () => {} }),
    /503 busy/,
  );
  assert.equal(session.prompts.length, 3);
  assert.match(logs.at(-1), /model endpoint still failing after 2 retry\(ies\)/);
});
