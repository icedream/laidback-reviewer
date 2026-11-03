/**
 * What the poster actually sends.
 *
 * A pending review is the same request with the event left out, so the difference between a review the
 * author sees and one only the operator sees lives in one key of one body.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HeadMovedError, submitReview } from "../../src/github/poster.mjs";

function stubClient({ headSha = "abc123", review = { id: 900, html_url: "https://github.com/acme/svc/pull/71#pullrequestreview-900", state: "PENDING" } } = {}) {
  const calls = [];
  return {
    calls,
    getPull: async () => ({ head: { sha: headSha } }),
    postReview: async (owner, repo, pr, payload) => {
      calls.push({ owner, repo, pr, payload });
      return review;
    },
  };
}

const comments = [{ path: "a.go", line: 4, body: "off by one" }];

test("a pending review is posted without an event", async () => {
  const client = stubClient();
  const posted = await submitReview({
    client,
    owner: "acme",
    repo: "svc",
    pr: 71,
    payload: { commit_id: "abc123", body: "two findings, both inline", comments },
    expectedHeadSha: "abc123",
  });

  assert.equal("event" in client.calls[0].payload, false, "no event key, which is how GitHub is told to leave it unsubmitted");
  assert.equal(client.calls[0].payload.commit_id, "abc123");
  assert.equal(posted.state, "PENDING");
});

test("a submitted review still carries its verdict", async () => {
  const client = stubClient({ review: { id: 901, html_url: "u", state: "APPROVED" } });
  await submitReview({
    client,
    owner: "acme",
    repo: "svc",
    pr: 71,
    payload: { commit_id: "abc123", event: "APPROVE", body: "LGTM", comments },
    expectedHeadSha: "abc123",
  });

  assert.equal(client.calls[0].payload.event, "APPROVE");
});

test("a review whose event says PENDING is not sent as one", async () => {
  const client = stubClient();
  await submitReview({
    client,
    owner: "acme",
    repo: "svc",
    pr: 71,
    payload: { commit_id: "abc123", event: "PENDING", body: "x", comments },
    expectedHeadSha: "abc123",
  });

  assert.equal("event" in client.calls[0].payload, false);
});

test("a head that moved before posting is refused rather than pinned to the old commit", async () => {
  const client = stubClient({ headSha: "def456" });
  await assert.rejects(
    () => submitReview({ client, owner: "acme", repo: "svc", pr: 71, payload: { commit_id: "abc123", event: "COMMENT", body: "x", comments }, expectedHeadSha: "abc123" }),
    HeadMovedError,
  );
  assert.equal(client.calls.length, 0, "nothing was posted");
});
