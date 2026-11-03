/**
 * What the operator changed on a review this bot already posted.
 *
 * A body rewritten in GitHub's UI is the clearest correction available: the findings were kept, and the
 * shape the reviewer did not want was cut. Seeing it needs no extra permission, because the composed body
 * is stored together with the GitHub review id it produced, and the PR's reviews are read on every pass.
 */

/** GitHub keeps CRLF in comment bodies and trims trailing spaces; an edit is what matters, not that. */
const flatten = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .trim();

/**
 * @param reviews the PR's reviews as GitHub lists them now
 * @param posted  this repository's stored rows for the PR: { github_review_id, body, ... }
 * @returns one entry per posted review whose body on GitHub no longer matches what was posted
 */
export function findRewrittenBodies({ reviews, posted }) {
  const byGithubId = new Map(
    (posted ?? []).filter((row) => row.github_review_id).map((row) => [String(row.github_review_id), row]),
  );

  const rewritten = [];
  for (const review of reviews ?? []) {
    const row = byGithubId.get(String(review.id));
    // A review this process never posted is somebody else's text, edited or not.
    if (!row) continue;
    if (flatten(review.body) === flatten(row.body)) continue;
    rewritten.push({ githubReviewId: String(review.id), review, row });
  }
  return rewritten;
}
