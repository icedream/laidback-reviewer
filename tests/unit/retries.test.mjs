/**
 * Spacing and parking for heads that fail.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { backoffMs, clearFailure, failurePlan, recordFailure } from "../../src/proposal/retries.mjs";

const cfg = { reviews: { maxAttemptsPerHead: 4, retryBaseMs: 60_000, retryMaxMs: 3_600_000 } };
const key = { owner: "example", repo: "orders-svc", pr: 143, head_sha: "a".repeat(40) };

test("the spacing doubles and stops at the cap", () => {
  assert.equal(backoffMs({ cfg, attempts: 1 }), 60_000);
  assert.equal(backoffMs({ cfg, attempts: 2 }), 120_000);
  assert.equal(backoffMs({ cfg, attempts: 3 }), 240_000);
  assert.equal(backoffMs({ cfg, attempts: 6 }), 1_920_000);
  assert.equal(backoffMs({ cfg, attempts: 7 }), 3_600_000, "capped");
  assert.equal(backoffMs({ cfg, attempts: 40 }), 3_600_000, "still capped");
});

test("a head with no failure record is attempted straight away", () => {
  const plan = failurePlan({ cfg, row: null });
  assert.equal(plan.tryNow, true);
  assert.equal(plan.attempts, 0);
});

test("a head inside its spacing window is held back, and named with the error", () => {
  const row = {
    attempts: 2,
    last_error: "model server is busy",
    next_try_at: new Date(Date.now() + 90_000).toISOString(),
    parked: 0,
  };
  const plan = failurePlan({ cfg, row });
  assert.equal(plan.tryNow, false);
  assert.ok(plan.waitSeconds >= 89 && plan.waitSeconds <= 90);
  assert.match(plan.reason, /attempt 2 failed \(model server is busy\); retrying in \d+s/);
});

test("a head past its window is attempted again, and a parked one never is", () => {
  const due = { attempts: 1, last_error: "boom", next_try_at: new Date(Date.now() - 1000).toISOString(), parked: 0 };
  assert.equal(failurePlan({ cfg, row: due }).tryNow, true);
  assert.match(failurePlan({ cfg, row: due }).reason, /retrying after 1 failed attempt/);

  const parked = { attempts: 4, last_error: "boom", next_try_at: new Date(Date.now() - 1000).toISOString(), parked: 1 };
  const plan = failurePlan({ cfg, row: parked });
  assert.equal(plan.tryNow, false);
  assert.equal(plan.parked, true);
  assert.match(plan.reason, /parked after 4 failed attempts/);
});

test("failures accumulate per head, park at the limit, and clear on a good run", () => {
  const store = openStore(":memory:");
  try {
    const log = [];
    const first = recordFailure({ cfg, store, key, error: new Error("model server is busy"), log: (line) => log.push(line) });
    assert.equal(first.attempts, 1);
    assert.equal(first.parked, false);
    assert.equal(first.waitMs, 60_000);
    assert.match(log[0], /retry in 60s, attempt 2 of 4/);

    recordFailure({ cfg, store, key, error: new Error("checkout failed"), log: () => {} });
    const third = recordFailure({ cfg, store, key, error: new Error("still busy"), log: () => {} });
    assert.equal(third.attempts, 3);
    assert.equal(third.waitMs, 240_000, "the curve follows the attempt count, not the clock");

    const parkedAt = recordFailure({ cfg, store, key, error: new Error("gave up"), log: (line) => log.push(line) });
    assert.equal(parkedAt.attempts, 4);
    assert.equal(parkedAt.parked, true);
    assert.match(log.at(-1), /parked example\/orders-svc#143 at a{8} after 4 attempts/);

    const row = store.getFailure(key);
    assert.equal(row.attempts, 4);
    assert.equal(row.parked, 1);
    assert.equal(row.last_error, "gave up");
    assert.deepEqual(store.listFailures().map((entry) => entry.pr), [143]);

    clearFailure({ store, key });
    assert.equal(store.getFailure(key), undefined);
    assert.deepEqual(store.listFailures(), []);
  } finally {
    store.close();
  }
});

test("long errors are truncated so the state row stays readable", () => {
  const store = openStore(":memory:");
  try {
    recordFailure({ cfg, store, key, error: new Error("x".repeat(900)), log: () => {} });
    assert.equal(store.getFailure(key).last_error.length, 400);
  } finally {
    store.close();
  }
});

test("a deferral remembers the session it stopped in", () => {
  const store = openStore(":memory:");
  try {
    const key = { owner: "acme", repo: "api", pr: 12, head_sha: "a".repeat(40) };
    store.deferHead({ ...key, until_at: "2026-04-04T00:00:00.000Z", reason: "model server busy", sessionFile: "/data/sessions/run-1.jsonl" });
    assert.equal(store.deferralFor(key).session_file, "/data/sessions/run-1.jsonl");
    store.clearDeferral(key);
    assert.equal(store.deferralFor(key), undefined);
  } finally {
    store.close();
  }
});
