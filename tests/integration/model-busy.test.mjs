/**
 * The poll loop when the inference server is occupied.
 *
 * A home server runs one prompt at a time and the interactive session usually holds the slot. Sending a
 * review anyway puts it in a queue that occupies a connection for minutes, and the PR then looks like a
 * failing review. The head is set aside instead, with no attempt counted against it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setupReviewRun } from "../helpers/run-env.mjs";

const busyOverrides = { agent: { model: { probe: "status", deferMs: 90_000, busyRetries: 0 } } };

const key = (env) => ({ owner: "example", repo: "orders-svc", pr: env.fixture.pr, head_sha: env.fixture.head.sha });

test("a busy server defers the head and never reaches the model", async () => {
  // The interactive session holds the slot for the first two cycles and frees it for the third.
  let free = false;
  const env = await setupReviewRun({
    turns: [],
    modelStatus: () => (free ? { busy: false, queued: 0, phase: "idle" } : { busy: true, queued: 0, phase: "reading the prompt", prompt_tokens: 64362 }),
    overrides: busyOverrides,
  });
  try {
    await env.cycle();

    const deferral = env.store.deferralFor(key(env));
    assert.ok(deferral, "the head is set aside");
    assert.ok(Date.parse(deferral.until_at) > Date.now(), "with a retry time, not a park");
    assert.match(deferral.reason, /model server busy \(reading the prompt\)/);
    assert.equal(env.store.getFailure(key(env)), undefined, "a busy server is not a failed review");
    assert.equal(env.model.requests().length, 0, "nothing was sent to the model");
    assert.match(env.log(), /model server busy \(reading the prompt\)/);
    assert.match(env.log(), /deferred: model server busy/);

    // The next cycle must not re-probe-and-send either, and it must not consume an attempt.
    await env.cycle();
    assert.match(env.log(), /deferred until/);
    assert.equal(env.model.requests().length, 0);

    // Once the window passes and the slot is free, the head is tried and the deferral is cleared.
    free = true;
    env.store.deferHead({ ...key(env), until_at: new Date(Date.now() - 1000).toISOString(), reason: "expired in the test" });
    await env.cycle();
    assert.equal(env.store.deferralFor(key(env)), undefined);
    assert.equal(env.model.requests().length, 1, "the review runs once the slot looks free");
    assert.ok(env.store.getFailure(key(env)), "an empty review after that is a normal failure");
  } finally {
    await env.close();
  }
});

test("a server with nothing to say about its queue does not block the review", async () => {
  const env = await setupReviewRun({ overrides: { agent: { model: { probe: "status", busyRetries: 0 } } } });
  try {
    // The fake model has no status route configured, so the probe finds no answer and stands down.
    await env.cycle();

    assert.equal(env.store.deferralFor(key(env)), undefined);
    assert.ok(env.store.reviewFor(key(env)), "the review went ahead");
  } finally {
    await env.close();
  }
});

test("a queue that forms after the turn started cancels it, and the progress output stops with it", async () => {
  // The first probe is the pre-prompt one and says the slot is free; every later one says something is
  // in front of us. The scripted turn answers slowly, which is what queuing looks like from here.
  let probes = 0;
  const env = await setupReviewRun({
    turns: [{ content: "reading the diff now" }],
    modelStatus: () =>
      ++probes === 1
        ? { busy: false, queued: 0, phase: "idle", generated: 0, promptTokens: 0 }
        : { busy: true, queued: 1, phase: "thinking", generated: 10, promptTokens: 500 },
    modelDelay: () => 6000,
    overrides: {
      agent: { model: { probe: "status", firstTokenMs: 2000, busyRetries: 0, deferMs: 90_000 } },
      logging: { progress: "tools", heartbeatMs: 1000 },
    },
  });
  try {
    await env.cycle();

    assert.ok(env.store.deferralFor(key(env)), "the head is set aside for the next cycle");
    assert.match(env.log(), /queued in front of us: cancelling the request/);

    // The heartbeat runs every 200ms while a session is live. If it outlives a cancelled run, the
    // process never exits and the log fills with "still working".
    const linesAfterRun = env.log().split("\n").length;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(env.log().split("\n").length, linesAfterRun, "nothing keeps printing after the run ends");
  } finally {
    await env.close();
  }
});

test("a deferral that never reached the prompt keeps the work worth resuming", async () => {
  const env = await setupReviewRun({ turns: [], modelStatus: { busy: true, queued: 0, phase: "reading the prompt" }, overrides: busyOverrides });
  try {
    const head = key(env);
    env.store.deferHead({
      ...head,
      until_at: new Date(Date.now() - 1000).toISOString(),
      reason: "earlier pause",
      sessionFile: "/data/sessions/earlier.jsonl",
      runId: "keep0001",
      checkoutDir: "/work/scratch/keep0001",
    });

    await env.cycle();

    const row = env.store.deferralFor(head);
    assert.ok(row, "still deferred");
    assert.equal(row.session_file, "/data/sessions/earlier.jsonl", "the transcript is still the one to fork");
    assert.equal(row.run_id, "keep0001", "and the tree is still the one to reuse");
  } finally {
    env.close();
  }
});
