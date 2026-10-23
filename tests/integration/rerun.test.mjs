/**
 * Another pass, asked for on the gate.
 *
 * The reason to re-run is that the reviewer improved, not that GitHub changed anything, so discovery will
 * not surface the head again. What is pinned here is that the request itself drives the pass, that a moved
 * head drops it, and that the per-head ceiling still applies.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { requestRerun } from "../../src/gate/gate.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";

function reviewed(store) {
  return store.db.prepare("SELECT id, owner, repo, pr, head_sha, created_at, updated_at, session_file FROM reviews ORDER BY created_at").all();
}

test("a rerun request runs a fresh pass over the same head", async () => {
  const env = await setupReviewRun();
  try {
    await env.cycle();
    const first = reviewed(env.store);
    assert.equal(first.length, 1, "the review request produced one pass");

    const [row] = first;
    env.store.requestRerun({ owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha, requested_by: "telegram:132295711", gate_id: null });
    assert.equal(env.store.pendingReruns().length, 1);

    env.model.resetTurns();
    await env.cycle();
    const second = reviewed(env.store);
    // A head carries one current proposal: the requested pass replaces the one it supersedes rather than
    // leaving two competing reviews on the same commit.
    assert.equal(second.length, 1, `one row for one head:\n${env.log()}`);
    assert.equal(second[0].head_sha, row.head_sha, "the same head, a new pass");
    assert.notEqual(second[0].updated_at, row.updated_at, "the row was rewritten by the new pass");
    assert.deepEqual(env.store.pendingReruns(), [], "the request is consumed once it has run");
    assert.match(env.log(), /rerun .*: another pass requested by telegram:132295711/);
    assert.match(env.log(), /task gate not opened: another pass was asked for on a gate/);
    assert.match(env.log(), /another pass requested at the gate/, "the reason reaches the candidate line as well");

    // A second pass counts as a re-review of that head, which the per-head ceiling caps.
    const seen = env.store.seenFor({ owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha });
    assert.ok(seen.rereviews >= 1, `the rerun was counted: ${JSON.stringify(seen)}`);
  } finally {
    env.close();
  }
});

test("a rerun whose head moved runs a pass over the new head", async () => {
  const env = await setupReviewRun();
  try {
    await env.cycle();
    const [row] = reviewed(env.store);
    env.store.requestRerun({ owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha, requested_by: "telegram:1", gate_id: null });
    env.github.setHead("ffffffffffffffffffffffffffffffffffffffff");
    env.model.resetTurns();

    await env.cycle();
    const heads = reviewed(env.store).map((r) => r.head_sha.slice(0, 8)).sort();
    assert.deepEqual(heads, [row.head_sha.slice(0, 8), "ffffffff"], "the pass lands on the head that exists now");
    assert.deepEqual(env.store.pendingReruns(), [], "the request is consumed");
    assert.match(env.log(), /the head moved to ffffffff since the request, that is what gets the new pass/);
  } finally {
    env.close();
  }
});

test("the per-head ceiling applies to a requested rerun too", async () => {
  const env = await setupReviewRun();
  try {
    await env.cycle();
    const [row] = reviewed(env.store);
    const key = { owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha };
    for (let i = 0; i < 3; i += 1) env.store.markSeen({ ...key, reReview: true });

    env.store.requestRerun({ ...key, requested_by: "telegram:1", gate_id: null });
    await env.cycle();

    assert.equal(reviewed(env.store).length, 1, "the ceiling held");
    assert.deepEqual(env.store.pendingReruns(), [], "and the request is not left to retry forever");
    assert.match(env.log(), /3 passes over this head already, the ceiling is 3/);
  } finally {
    env.close();
  }
});

test("the requested rerun starts from the transcript of the pass it replaces", async () => {
  const env = await setupReviewRun({ context: {} });
  try {
    await env.cycle();
    const [row] = reviewed(env.store);
    const firstAsks = env.model.requests().map((request) => request.messages.length);

    env.store.requestRerun({ owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha, requested_by: "telegram:132295711", gate_id: null });
    env.model.resetTurns();
    await env.cycle();

    const after = reviewed(env.store);
    assert.equal(after.length, 1, `the rerun replaced the row for this head:
${env.log()}`);
    assert.match(env.log(), /forking the pass that is being replaced, from /);
    assert.ok(after[0].session_file, "the row now points at the new pass's transcript");

    const second = env.model.requests().slice(firstAsks.length);
    assert.ok(second.length, "the second pass reached the model");
    const prompt = JSON.stringify(second[0].messages);
    assert.match(prompt, /another pass was asked for on the gate that held the previous review/);
    assert.match(prompt, /being replaced, not corrected/);
    assert.ok(
      second[0].messages.length > firstAsks[0],
      `the fork carries the earlier pass: ${second[0].messages.length} messages against ${firstAsks[0]}`,
    );
  } finally {
    env.close();
  }
});

test("the command line can ask for another pass on a gate whose message has no control for it", async () => {
  const { execFileSync } = await import("node:child_process");
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: false, beforePost: true } } });
  try {
    await env.cycle();
    const [row] = reviewed(env.store);
    const gateId = env.store.db.prepare("SELECT id FROM gates WHERE pr = @pr ORDER BY created_at DESC LIMIT 1").get({ pr: row.pr }).id;

    const out = execFileSync(
      process.execPath,
      ["src/cli/gate.mjs", "rerun", gateId],
      {
        encoding: "utf8",
        env: { ...process.env, LAIDBACK_CONFIG: `${env.dir}/config.yaml`, LAIDBACK_STATE_DB: `${env.dir}/state.db`, USER: "operator" },
      },
    );
    assert.match(out, /another pass over example\/orders-svc#143 at /);
    assert.deepEqual(
      env.store.pendingReruns().map((entry) => [entry.pr, entry.requested_by]),
      [[143, "cli:operator"]],
    );
    const gate = env.store.getGate(gateId);
    assert.equal(gate.state, "rejected", "the proposal it replaces stops waiting for approval");
    assert.equal(gate.reason, "superseded by another pass");
    assert.deepEqual(env.store.approvedUnpostedReviews(), [], "and it is not posted behind the new pass");

    env.model.resetTurns();
    await env.cycle();
    assert.match(env.log(), /rerun .*: another pass requested by cli:operator/);
  } finally {
    env.close();
  }
});

test("a held proposal is superseded when another pass is asked for", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: false, beforePost: true } } });
  try {
    await env.cycle();
    const [row] = reviewed(env.store);
    const gate = env.store.latestGateFor({ owner: row.owner, repo: row.repo, pr: row.pr, stage: "before_post" });
    env.store.decideGate({ id: gate.id, state: "held", decided_by: "telegram:1" });

    requestRerun({ store: env.store, gate: env.store.getGate(gate.id), by: "cli", log: () => {} });
    const settled = env.store.getGate(gate.id);
    assert.equal(settled.state, "rejected");
    assert.equal(settled.reason, "superseded by another pass");

    env.model.resetTurns();
    await env.cycle();
    assert.equal(env.store.approvedUnpostedReviews().length, 0, "the superseded proposal cannot post behind the new pass");
  } finally {
    env.close();
  }
});
