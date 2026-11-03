/**
 * Posting a review the operator held back as a pending one.
 *
 * The gate decision is an approval; the mode on it says the review must reach GitHub without being
 * submitted. That difference is applied when the review is finally posted, against the current head.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { postApprovedReview } from "../../src/proposal/repost.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

const HEAD = "c".repeat(40);

function seeded({ mode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-repost-"));
  const store = openStore(path.join(dir, "state.db"));
  const composed = {
    verdict: "approve",
    action: "hint",
    event: "COMMENT",
    payload: { body: "LGTM. one nit inline", comments: [{ path: "a.go", line: 2, body: "call it name" }] },
    proposalBody: "LGTM. one nit inline",
    proposalBlocking: [],
    decisions: [],
    notes: [],
  };
  const id = store.saveReview({ owner: "acme", repo: "svc", pr: 71, head_sha: HEAD, composed, dryRun: false, notes: [] });
  const gateId = store.openGate({ kind: "before_post:telegram", review_id: id, summary: "s", owner: "acme", repo: "svc", pr: 71, head_sha: HEAD });
  store.decideGate({ id: gateId, state: "approved", decided_by: "telegram:4242", reason: "", mode });
  return { dir, store, id };
}

function stubClient() {
  const calls = [];
  return {
    calls,
    getPull: async () => ({ head: { sha: HEAD } }),
    listFiles: async () => [{ filename: "a.go", status: "modified", patch: "@@ -1,2 +1,3 @@\n one\n+two\n three" }],
    postReview: async (owner, repo, pr, payload) => {
      calls.push(payload);
      const state = "event" in payload ? payload.event === "APPROVE" ? "APPROVED" : "COMMENTED" : "PENDING";
      return { id: 880, html_url: "https://github.com/acme/svc/pull/71#pullrequestreview-880", state };
    },
  };
}

test("a gate tapped as pending posts the review without an event", async () => {
  const seededCase = seeded({ mode: "pending" });
  const client = stubClient();
  const cfg = baseConfig({ dir: seededCase.dir });
  cfg.reviews.dryRun = false;
  try {
    const result = await postApprovedReview({ cfg, store: seededCase.store, client, reviewId: seededCase.id, log: () => {} });

    assert.equal("event" in client.calls[0], false, "no event: GitHub leaves it unsubmitted");
    assert.equal(result.posted.state, "PENDING");
    const row = seededCase.store.getReview(seededCase.id);
    assert.equal(row.posted, 1);
    assert.equal(row.post_state, "pending");
  } finally {
    seededCase.store.close();
    fs.rmSync(seededCase.dir, { recursive: true, force: true });
  }
});

test("an ordinary approval still carries its verdict", async () => {
  const seededCase = seeded({ mode: null });
  const client = stubClient();
  const cfg = baseConfig({ dir: seededCase.dir });
  cfg.reviews.dryRun = false;
  cfg.reviews.approve = "submit";
  try {
    await postApprovedReview({ cfg, store: seededCase.store, client, reviewId: seededCase.id, log: () => {} });

    assert.equal(client.calls[0].event, "APPROVE");
    assert.equal(seededCase.store.getReview(seededCase.id).post_state, "submitted");
  } finally {
    seededCase.store.close();
    fs.rmSync(seededCase.dir, { recursive: true, force: true });
  }
});
