/**
 * Reading an operator's edit of a review this bot posted.
 *
 * GitHub holds the current body, and the store holds the body that was posted against the GitHub review
 * id it produced. The comparison is what says "the reviewer cut the opener", without asking a model to
 * notice it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { findRewrittenBodies } from "../../src/proposal/edits.mjs";

const posted = [
  { github_review_id: "101", body: "LGTM.\n\nThe pin is the one CI runs." },
  { github_review_id: "102", body: "Two findings, both inline." },
];

test("a body the operator rewrote is recognised, and the unchanged one is not", () => {
  const reviews = [
    { id: 101, user: { login: "octocat" }, state: "APPROVED", body: "The pin is the one CI runs." },
    { id: 102, user: { login: "octocat" }, state: "COMMENTED", body: "Two findings, both inline." },
  ];

  const found = findRewrittenBodies({ reviews, posted });
  assert.deepEqual(found.map((entry) => entry.githubReviewId), ["101"]);
  assert.equal(found[0].row.body, "LGTM.\n\nThe pin is the one CI runs.", "the text as posted comes back with it");
});

test("line endings and trailing space are not an edit", () => {
  const reviews = [{ id: 101, body: "LGTM.\r\n\r\n   The pin is the one CI runs. " }];

  assert.deepEqual(findRewrittenBodies({ reviews, posted }), []);
});

test("a review this process never posted is not its own business", () => {
  const reviews = [{ id: 999, user: { login: "someone-else" }, state: "CHANGES_REQUESTED", body: "not ours" }];

  assert.deepEqual(findRewrittenBodies({ reviews, posted }), []);
});

test("postedReviewsForPr returns only posted rows that carry a GitHub review id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-edits-"));
  const store = openStore(path.join(dir, "state.db"));
  try {
    const key = { owner: "acme", repo: "svc", pr: 71 };
    const composed = ({ body, ...rest }) => ({ verdict: "approve", action: "submit", event: "APPROVE", payload: { body, comments: [] }, proposalBody: body, proposalBlocking: [], decisions: [], notes: [], ...rest });
    const withId = store.saveReview({ ...key, head_sha: "aaa", composed: composed({ body: "LGTM." }), dryRun: false, notes: [] });
    store.markPosted({ id: withId, github_review_id: "555", html_url: "https://github.com/acme/svc/pull/71#pullrequestreview-555" });
    store.saveReview({ ...key, head_sha: "bbb", composed: composed({ body: "held back", action: "hint", event: "COMMENT" }), dryRun: true, notes: [] });
    const unposted = store.saveReview({ ...key, head_sha: "ccc", composed: composed({ body: "approved, never posted" }), dryRun: false, notes: [] });
    store.markPosted({ id: unposted, github_review_id: null, html_url: null });

    const rows = store.postedReviewsForPr(key);
    assert.deepEqual(rows.map((row) => [row.head_sha, row.github_review_id]), [["aaa", "555"]]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
