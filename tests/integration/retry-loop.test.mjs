/**
 * The poll loop when a run fails.
 *
 * The failure here is a model turn that produced no review: a branch that does not build, a session
 * that ends early. Without a record of it, the next cycle re-runs the same head forever.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setupReviewRun } from "../helpers/run-env.mjs";

const retryOverrides = {
  reviews: { maxAttemptsPerHead: 3, retryBaseMs: 1000, retryMaxMs: 4000 },
  agent: { model: { busyRetries: 0 } },
};

const failureKey = (env) => ({ owner: "example", repo: "orders-svc", pr: env.fixture.pr, head_sha: env.fixture.head.sha });

/** Move a head's next attempt into the past, which is what the spacing window would otherwise do. */
function release(env, attempts, parked = 0) {
  const key = failureKey(env);
  env.store.recordFailure({
    ...key,
    attempts,
    last_error: "the model turn produced no review",
    next_try_at: new Date(Date.now() - 1000).toISOString(),
    parked,
  });
}

test("a head whose run failed is spaced out, retried, then parked", async () => {
  // An empty script: every turn yields prose and no review, so review-run refuses to compose.
  const env = await setupReviewRun({ overrides: retryOverrides, turns: [] });
  try {
    await env.cycle();

    const row = env.store.getFailure(failureKey(env));
    assert.ok(row, "the failure is recorded against the head");
    assert.equal(row.attempts, 1);
    assert.equal(row.parked, 0);
    assert.ok(new Date(row.next_try_at) > new Date(), "the next attempt is scheduled ahead");
    assert.match(env.log(), /retry in 1s, attempt 2 of 3/);
    assert.equal(env.store.reviewFor(failureKey(env)), undefined, "a failed run stores no review");

    // Second cycle right away: the window must hold it back rather than re-run.
    const askedAfterFirst = env.model.requests().length;
    await env.cycle();
    assert.match(env.log(), /skipped, attempt 1 failed/);
    assert.equal(env.model.requests().length, askedAfterFirst, "the waiting head never reaches the model");
    assert.equal(env.store.getFailure(failureKey(env)).attempts, 1);

    release(env, 1);
    await env.cycle();
    assert.equal(env.store.getFailure(failureKey(env)).attempts, 2);

    release(env, 2);
    await env.cycle();
    const parked = env.store.getFailure(failureKey(env));
    assert.equal(parked.attempts, 3);
    assert.equal(parked.parked, 1);
    assert.match(env.log(), /parked example\/orders-svc#143/);

    // Parked means done, even with the window in the past: the parked branch stops it.
    const askedBefore = env.model.requests().length;
    release(env, 3, 1);
    await env.cycle();
    assert.equal(env.model.requests().length, askedBefore, "a parked head never reaches the model again");
    assert.match(env.log(), /skipped, parked after 3 failed attempts/);
    assert.deepEqual(env.store.listFailures().map((entry) => [entry.pr, entry.parked]), [[env.fixture.pr, 1]]);
  } finally {
    env.close();
  }
});

test("a busy upstream response does not lose the review", async () => {
  const env = await setupReviewRun({
    overrides: { agent: { model: { busyRetries: 2, busyBackoffMs: 1 } } },
    modelFails: [0],
  });
  try {
    const result = await env.run();

    assert.ok(result.composed.verdict, "the review still composes");
    const requests = env.model.requests();
    assert.equal(requests[0].failed, true, "the first attempt met a 503");
    assert.ok(requests.some((request) => !request.failed), "a later attempt was served");
    assert.equal(env.store.getFailure(failureKey(env)), undefined, "and the head carries no failure record");

    const row = env.store.reviewFor({ owner: "example", repo: "orders-svc", pr: env.fixture.pr, head_sha: env.fixture.head.sha });
    const notes = JSON.parse(row.notes ?? "[]");
    assert.ok(!notes.some((note) => /no review|failed/.test(note)), `no failure notes expected, got: ${notes.join(" | ")}`);
  } finally {
    env.close();
  }
});

test("a run that recovers clears the failure record for its head", async () => {
  const env = await setupReviewRun({ overrides: retryOverrides });
  try {
    const key = failureKey(env);
    env.store.recordFailure({
      ...key,
      attempts: 2,
      last_error: "model server is busy",
      next_try_at: new Date(Date.now() - 1000).toISOString(),
      parked: 0,
    });

    await env.cycle();
    assert.equal(env.store.getFailure(key), undefined, "success ends the failure streak");
    assert.ok(env.store.reviewFor(key), "and the review is stored");
  } finally {
    env.close();
  }
});
