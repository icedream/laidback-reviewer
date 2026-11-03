/**
 * What happens to a review GitHub is holding unsubmitted.
 *
 * The bot cannot submit or delete it, so the only work here is noticing the two changes that matter: the
 * operator finished it, or the author pushed and made its anchors wrong.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { sweepPendingPosts } from "../../src/proposal/pending.mjs";

const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

function seededRow({ postState = "pending", headSha = HEAD } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-pending-"));
  const store = openStore(path.join(dir, "state.db"));
  const composed = { verdict: "approve", action: "pending", event: "PENDING", payload: { body: "two findings, both inline", comments: [] }, proposalBody: "two findings, both inline", proposalBlocking: [], decisions: [], notes: [] };
  const id = store.saveReview({ owner: "acme", repo: "svc", pr: 71, head_sha: headSha, composed, dryRun: false, notes: [] });
  store.markPosted({ id, github_review_id: "777", html_url: "https://github.com/acme/svc/pull/71#pullrequestreview-777", postState });
  return { dir, store, id };
}

const clientFor = ({ reviews = [], head = HEAD }) => ({
  listReviews: async () => reviews,
  getPull: async () => ({ head: { sha: head } }),
});

test("a pending row is the only thing the sweep looks at", () => {
  const seeded = seededRow();
  try {
    assert.deepEqual(seeded.store.pendingPosts().map((row) => [row.github_review_id, row.post_state]), [["777", "pending"]]);
    const other = seeded.store.saveReview({ owner: "acme", repo: "svc", pr: 72, head_sha: HEAD, composed: { ...seeded.store.getReview(seeded.id), verdict: "approve", action: "submit", event: "APPROVE", payload: { body: "x", comments: [] } }, dryRun: false, notes: [] });
    seeded.store.markPosted({ id: other, github_review_id: "778", html_url: "u", postState: "submitted" });
    assert.deepEqual(seeded.store.pendingPosts().map((row) => row.pr), [71], "the submitted row dropped out");
  } finally {
    seeded.store.close();
    fs.rmSync(seeded.dir, { recursive: true, force: true });
  }
});

test("an operator submitting the review in GitHub settles the row", async () => {
  const seeded = seededRow();
  try {
    const changed = await sweepPendingPosts({ store: seeded.store, client: clientFor({ reviews: [{ id: 777, state: "COMMENTED" }] }) });

    assert.deepEqual(changed.map((entry) => entry.state), ["submitted"]);
    assert.equal(seeded.store.getReview(seeded.id).post_state, "submitted");
  } finally {
    seeded.store.close();
    fs.rmSync(seeded.dir, { recursive: true, force: true });
  }
});

test("a push under an unsubmitted review warns once, naming both commits", async () => {
  const seeded = seededRow();
  const notices = [];
  try {
    const changed = await sweepPendingPosts({
      store: seeded.store,
      client: clientFor({ reviews: [{ id: 777, state: "PENDING" }], head: NEW_HEAD }),
      notify: async (text) => notices.push(text),
    });
    const again = await sweepPendingPosts({
      store: seeded.store,
      client: clientFor({ reviews: [{ id: 777, state: "PENDING" }], head: NEW_HEAD }),
      notify: async (text) => notices.push(text),
    });

    assert.equal(changed[0].state, "pending_stale");
    assert.equal(notices.length, 1, "the second cycle has nothing new to say");
    assert.equal(again.length, 0);
    assert.match(notices[0], /unsubmitted review at a{8}; the head is now b{8}/);
    assert.match(notices[0], /anchors are out of date/);
  } finally {
    seeded.store.close();
    fs.rmSync(seeded.dir, { recursive: true, force: true });
  }
});

test("a review GitHub does not list is read as still waiting", async () => {
  const seeded = seededRow();
  const logs = [];
  try {
    const changed = await sweepPendingPosts({ store: seeded.store, client: clientFor({ reviews: [], head: NEW_HEAD }), log: (line) => logs.push(line) });

    assert.deepEqual(changed.map((entry) => entry.state), ["pending_stale"], "the head moved, which is the part worth saying");
    assert.equal(seeded.store.getReview(seeded.id).post_state, "pending_stale");
  } finally {
    seeded.store.close();
    fs.rmSync(seeded.dir, { recursive: true, force: true });
  }
});

test("an unreadable pull request costs the sweep one line", async () => {
  const seeded = seededRow();
  const logs = [];
  try {
    const changed = await sweepPendingPosts({
      store: seeded.store,
      client: { listReviews: async () => { throw new Error("HTTP 403"); }, getPull: async () => ({ head: { sha: NEW_HEAD } }) },
      log: (line) => logs.push(line),
    });

    assert.deepEqual(changed, []);
    assert.equal(logs[0], "pending review 777: HTTP 403");
    assert.equal(seeded.store.getReview(seeded.id).post_state, "pending", "nothing is concluded from a failed read");
  } finally {
    seeded.store.close();
    fs.rmSync(seeded.dir, { recursive: true, force: true });
  }
});
