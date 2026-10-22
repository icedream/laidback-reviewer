/**
 * Posting a review after the fact.
 *
 * A queued review is often approved hours later, by which time the branch may have moved. The stored
 * proposal is re-composed against the PR's current diff instead of replaying frozen line numbers, so
 * an approved-but-stale review lands on the right lines or not at all.
 */

import { submitReview } from "../github/poster.mjs";
import { composeReview } from "./policy.mjs";

export async function postApprovedReview({ cfg, store, client, reviewId, log = () => {} }) {
  const row = store.getReview(reviewId);
  if (!row) return { skipped: "not_found" };
  if (row.posted) return { skipped: "already_posted", html_url: row.html_url };
  if (cfg.reviews.dryRun) return { skipped: "dry_run" };

  const gates = store.gatesForReview(reviewId);
  const approved = gates.find((gate) => gate.state === "approved");
  if (cfg.gate.beforePost && gates.length && !approved) {
    return { skipped: "gate_not_approved", gates: gates.map((gate) => `${gate.id}:${gate.state}`) };
  }

  const pr = await client.getPull(row.owner, row.repo, row.pr);
  const currentHead = pr.head.sha;
  if (currentHead !== row.head_sha) {
    log(`head moved ${row.head_sha.slice(0, 8)} → ${currentHead.slice(0, 8)} since the review was composed; re-anchoring`);
  }
  const files = await client.listFiles(row.owner, row.repo, row.pr);

  const proposal = {
    comments: store.commentsFor(reviewId).map((comment) => ({
      path: comment.path,
      line: comment.line,
      ...(comment.start_line ? { start_line: comment.start_line } : {}),
      body: comment.body,
    })),
    body: row.proposed_body ?? row.body ?? "",
    verdict: row.verdict,
    blocking: JSON.parse(row.blocking ?? "[]"),
  };

  const composed = composeReview({ proposal, cfg, files, headSha: currentHead, owner: row.owner, repo: row.repo });
  const posted = await submitReview({ client, owner: row.owner, repo: row.repo, pr: row.pr, payload: composed.payload, expectedHeadSha: currentHead });
  store.markPosted({ id: reviewId, github_review_id: posted.id, html_url: posted.html_url });
  log(`posted ${posted.state} on ${row.owner}/${row.repo}#${row.pr}: ${posted.html_url}`);
  return { posted, composed };
}

/** Approvals that arrived since the last cycle and have not been acted on. */
export function approvedReviewsAwaitingPost({ store }) {
  return store.approvedUnpostedReviews();
}
