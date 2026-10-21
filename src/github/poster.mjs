/**
 * The only GitHub write in the codebase.
 *
 * The head is re-read before posting: a stack gets force-pushed mid-review, and a review pinned to a
 * stale head either fails or lands on lines the author no longer has.
 */

export class HeadMovedError extends Error {
  constructor({ owner, repo, pr, expected, actual }) {
    super(`PR ${owner}/${repo}#${pr} head moved: ${expected?.slice(0, 8)} → ${actual?.slice(0, 8)}`);
    this.name = "HeadMovedError";
    this.expected = expected;
    this.actual = actual;
  }
}

export async function submitReview({ client, owner, repo, pr, payload, expectedHeadSha }) {
  const current = await client.getPull(owner, repo, pr);
  const actual = current.head?.sha;
  if (actual && expectedHeadSha && actual !== expectedHeadSha) {
    throw new HeadMovedError({ owner, repo, pr, expected: expectedHeadSha, actual });
  }

  const review = await client.postReview(owner, repo, pr, {
    commit_id: expectedHeadSha,
    event: payload.event,
    body: payload.body,
    comments: payload.comments.map((comment) => ({
      path: comment.path,
      ...(comment.start_line ? { start_line: comment.start_line, start_side: "RIGHT" } : {}),
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });

  return { id: String(review.id), html_url: review.html_url, state: review.state };
}
