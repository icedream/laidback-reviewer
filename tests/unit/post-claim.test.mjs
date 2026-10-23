/**
 * One poster per review.
 *
 * A tap is now acted on while a pass is still running, so the poster and a discovery cycle can reach the
 * same approval at the same moment. The claim is taken before anything touches GitHub.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { postApprovedReview } from "../../src/proposal/repost.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

const HEAD = "a".repeat(40);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "post-claim-"));
  const store = openStore(path.join(dir, "state.db"));
  const cfg = baseConfig({ dir });
  cfg.reviews.dryRun = false;
  const reviewId = store.saveReview({
    owner: "acme",
    repo: "orders-svc",
    pr: 7,
    head_sha: HEAD,
    composed: {
      verdict: "comment",
      action: "submit",
      event: "COMMENTED",
      payload: { body: "two findings", comments: [] },
      proposalBody: "two findings",
      proposalBlocking: [],
    },
    dryRun: false,
  });
  const gateId = store.openGate({ kind: "before_post", review_id: reviewId, summary: "ready", owner: "acme", repo: "orders-svc", pr: 7, head_sha: HEAD });
  store.decideGate({ id: gateId, state: "approved", decided_by: "telegram:1" });
  const posted = [];
  const client = {
    getPull: async () => ({ head: { sha: HEAD }, html_url: "https://github.com/acme/orders-svc/pull/7" }),
    listFiles: async () => [],
    postReview: async (_owner, _repo, _pr, payload) => {
      posted.push(payload);
      return { id: 99, html_url: "https://github.com/acme/orders-svc/pull/7#pullrequestreview-99", state: "COMMENTED" };
    },
  };
  return { cfg, store, reviewId, client, posted, close: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("the second caller on the same approval does not post again", async () => {
  const f = fixture();
  try {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const slow = { ...f.client, getPull: async () => { await hold; return { head: { sha: HEAD } }; } };

    const first = postApprovedReview({ cfg: f.cfg, store: f.store, client: slow, reviewId: f.reviewId });
    const second = await postApprovedReview({ cfg: f.cfg, store: f.store, client: f.client, reviewId: f.reviewId });
    assert.equal(second.skipped, "posting_elsewhere");

    release();
    await first;
    assert.equal(f.posted.length, 1, "one review reached GitHub");
    assert.equal(f.store.getReview(f.reviewId).posted, 1);
  } finally {
    f.close();
  }
});

test("a failed post gives the review back", async () => {
  const f = fixture();
  try {
    const broken = { ...f.client, listFiles: async () => { throw new Error("api rate limited"); } };
    await assert.rejects(() => postApprovedReview({ cfg: f.cfg, store: f.store, client: broken, reviewId: f.reviewId }), /rate limited/);
    assert.equal(f.store.getReview(f.reviewId).posted, 0);

    const again = await postApprovedReview({ cfg: f.cfg, store: f.store, client: f.client, reviewId: f.reviewId });
    assert.ok(again.posted, "the review posts once the failure clears");
  } finally {
    f.close();
  }
});

test("a claim left by a process that died is reclaimable", () => {
  const f = fixture();
  try {
    assert.equal(f.store.claimForPost({ id: f.reviewId }), true);
    assert.equal(f.store.claimForPost({ id: f.reviewId }), false, "a live claim keeps its holder");
    assert.equal(f.store.claimForPost({ id: f.reviewId, staleAfterMs: -1000 }), true, "an older claim is taken over");
  } finally {
    f.close();
  }
});
