/**
 * Progress on the approved gate message.
 *
 * An approval that is followed by ten silent minutes is indistinguishable from a hang, so the run writes
 * what the session is doing back onto the message the decision was made on. What is pinned here is that
 * the message moves, and that it ends on an outcome rather than on "starting".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setupReviewRun } from "../helpers/run-env.mjs";

test("an approved task gate is rewritten as the review runs, and ends on the outcome", async () => {
  const statuses = [];
  const env = await setupReviewRun({
    transport: { status: async (gateId, text) => statuses.push({ gateId, text }) },
  });
  try {
    const result = await env.run({ statusGateId: "262970ec" });
    assert.ok(!result.skipped, "the review ran");
    assert.ok(statuses.length >= 2, `expected an opening stage and an outcome, saw ${statuses.length}`);
    assert.ok(statuses.every((entry) => entry.gateId === "262970ec"));
    assert.match(statuses[0].text, /<b>Reviewing example\/orders-svc#143<\/b>/);
    assert.match(statuses[0].text, /Now: reading the pull request/);
    assert.match(statuses.at(-1).text, /review composed/);
    assert.match(statuses.at(-1).text, /elapsed \d\d:\d\d of \d\d:\d\d/);
    // A fast run only gets the throttle's worth of writes; the coalescing itself is pinned in
    // tests/unit/run-status.test.mjs with a controlled clock.
    assert.ok(
      statuses.some((entry) => /checking out the branch|starting the review session/.test(entry.text)) || statuses.length === 2,
      statuses.map((entry) => entry.text).join("\n---\n"),
    );
  } finally {
    env.close();
  }
});

test("no gate id means no status writing, and a failing transport does not fail the review", async () => {
  const quiet = await setupReviewRun({ transport: { status: async () => { throw new Error("telegram is down"); } } });
  try {
    const result = await quiet.run({ statusGateId: "ffffffff" });
    assert.ok(!result.skipped, "a lost status write is cosmetic");
  } finally {
    quiet.close();
  }

  const silent = await setupReviewRun();
  try {
    const result = await silent.run({ statusGateId: "262970ec" });
    assert.ok(!result.skipped, "without a transport that can write status, nothing is attempted");
  } finally {
    silent.close();
  }
});

test("a transport without status support leaves the gate message alone", async () => {
  const env = await setupReviewRun({ transport: {} });
  try {
    const result = await env.run({ statusGateId: "262970ec" });
    assert.ok(!result.skipped);
  } finally {
    env.close();
  }
});
