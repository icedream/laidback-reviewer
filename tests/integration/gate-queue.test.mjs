/**
 * The task gate queues a head once.
 *
 * A head that has not been reviewed yet is not in `seen`, so without a check the next cycle asks again.
 * One pending gate per head is what keeps the queue readable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";

test("a head waiting behind a task gate is not queued again on the next cycle", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    await env.cycle();

    const pending = env.store.pendingGates();
    assert.equal(pending.length, 1, `expected one queued task gate, got ${JSON.stringify(pending.map((gate) => gate.id))}`);
    assert.equal(pending[0].kind, "before_review:cli");
    assert.equal(pending[0].pr, env.fixture.pr, "the gate knows which pull it belongs to");
    assert.equal(env.model.requests().length, 0, "no model time is spent while the task gate waits");
  } finally {
    env.close();
  }
});

test("the gate for one stage does not stand in for the other", () => {
  const store = openStore(":memory:");
  try {
    const key = { owner: "acme", repo: "svc", pr: 7, head_sha: "abc123" };
    const postGate = store.openGate({ kind: "before_post:cli", summary: "post?", ...key });

    assert.equal(store.pendingGateFor({ ...key, stage: "before_review" }), undefined, "a post gate does not block a task gate");
    assert.equal(store.pendingGateFor({ ...key, stage: "before_post" }).id, postGate);

    store.decideGate({ id: postGate, state: "approved", decided_by: "cli", reason: "" });
    assert.equal(store.pendingGateFor({ ...key, stage: "before_post" }), undefined, "a decided gate stops holding the head");
  } finally {
    store.close();
  }
});
