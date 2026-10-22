/**
 * A task gate answers one review request.
 *
 * The same request must not gate a head once per cycle, and an approval has to release the head instead of
 * being read and forgotten. Both are easy to get wrong in a way that only shows up live, as an unread
 * message every two minutes for an ask that was already answered.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { taskGateDecision } from "../../src/gate/gate.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";

test("one request queues one task gate, not one per cycle", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    await env.cycle();
    await env.cycle();

    const pending = env.store.pendingGates();
    assert.equal(pending.length, 1, `expected one queued task gate, got ${JSON.stringify(pending.map((gate) => gate.id))}`);
    assert.equal(pending[0].kind, "before_review:cli");
    assert.equal(pending[0].pr, env.fixture.pr, "the gate knows which pull it belongs to");
    assert.ok(pending[0].request_ts, "the gate records the request it answers");
    assert.equal(env.model.requests().length, 0, "no model time is spent while the task gate waits");
  } finally {
    env.close();
  }
});

test("approving the task gate runs the review, once", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    const [queued] = env.store.pendingGates();
    env.store.decideGate({ id: queued.id, state: "approved", decided_by: "cli", reason: "" });

    await env.cycle();

    assert.ok(env.model.requests().length, "the approval released the head");
    assert.equal(env.github.postedReviews().length, 1, "the review went out once");
    const gate = env.store.getGate(queued.id);
    assert.ok(gate.consumed_at, "the approval is spent, not waiting to be read again");

    await env.cycle();
    assert.equal(env.github.postedReviews().length, 1, "a later cycle does not run it a second time");
    assert.equal(env.store.pendingGates().length, 0);
  } finally {
    env.close();
  }
});

test("the decision a head's existing gate implies, by request", () => {
  const cases = [
    { prior: null, askedAt: "2026-04-03T11:24:00Z", want: { kind: "none", proceed: false }, why: "nothing has been asked about this head yet" },
    { prior: { id: "g1", state: "pending", request_ts: "2026-04-03T11:24:00Z" }, askedAt: "2026-04-03T11:24:00Z", want: { kind: "pending", proceed: false }, why: "the same request is already waiting" },
    { prior: { id: "g1", state: "approved", request_ts: "2026-04-03T11:24:00Z" }, askedAt: "2026-04-03T11:24:00Z", want: { kind: "approved", proceed: true }, why: "an unused approval releases the head" },
    {
      prior: { id: "g1", state: "approved", request_ts: "2026-04-03T11:24:00Z", consumed_at: "2026-04-03T12:00:00Z" },
      askedAt: "2026-04-03T11:24:00Z",
      want: { kind: "consumed", proceed: false },
      why: "one approval, one run",
    },
    { prior: { id: "g1", state: "rejected", request_ts: "2026-04-03T11:24:00Z" }, askedAt: "2026-04-03T11:24:00Z", want: { kind: "rejected", proceed: false }, why: "no means no to that request" },
    { prior: { id: "g1", state: "rejected", request_ts: "2026-04-03T11:24:00Z" }, askedAt: "2026-04-05T09:00:00Z", want: { kind: "re-requested", proceed: false }, why: "a newer ask is a new gate" },
    { prior: { id: "g1", state: "pending", request_ts: "2026-04-03T11:24:00Z" }, askedAt: "2026-04-05T09:00:00Z", want: { kind: "re-requested", proceed: false }, why: "the older gate does not answer the newer request" },
  ];

  for (const testCase of cases) {
    const decision = taskGateDecision(testCase.prior, testCase.askedAt);
    assert.equal(decision.kind, testCase.want.kind, testCase.why);
    assert.equal(decision.proceed, testCase.want.proceed, testCase.why);
  }
});

test("a gate carries the request it answers", () => {
  const store = openStore(":memory:");
  try {
    const key = { owner: "acme", repo: "svc", pr: 7, head_sha: "abc123" };
    const id = store.openGate({ kind: "before_review:cli", summary: "run?", ...key, request_ts: "2026-04-03T11:24:00Z" });

    assert.equal(store.latestGateFor({ ...key, stage: "before_review" }).request_ts, "2026-04-03T11:24:00Z");
    store.consumeGate(id);
    assert.ok(store.getGate(id).consumed_at);
  } finally {
    store.close();
  }
});
