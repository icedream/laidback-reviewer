/**
 * End-to-end review flow over a synthetic repository with a medium-complexity change.
 *
 * The model here is scripted (tests/fakes/model.mjs): it stands in for turn shape, not for review
 * quality, so these assertions are about what the harness is allowed to send. The live review
 * behaviour against the real agent and a real model is tests/integration/live-smoke.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupReviewRun } from "../helpers/run-env.mjs";

const SIX_COMMENTS = 6;

test("dry run composes the review, repairs anchors, and writes nothing to GitHub", async () => {
  const env = await setupReviewRun();
  try {
    const result = await env.run();

    assert.equal(result.posted, null);
    assert.equal(result.dryRun, true);
    assert.equal(env.github.writes().length, 0, "a dry run must not send any write");
    assert.equal(env.github.violations().length, 0, `unexpected API paths: ${JSON.stringify(env.github.violations())}`);

    // The proposal carries six comments; two anchors are invalid and the harness repairs them.
    assert.equal(result.composed.payload.comments.length, SIX_COMMENTS);
    const anchored = result.composed.payload.comments.filter((comment) => comment.note);
    assert.equal(anchored.length, 2, `expected two repaired anchors, got ${JSON.stringify(anchored.map((c) => c.note))}`);

    // Every comment must sit on a line the API diff actually contains. Scanned independently of the
    // anchoring module so the check does not lean on the code it is testing.
    const rightSideLines = (patch) => {
      const lines = new Set();
      let current = null;
      for (const raw of patch.split("\n")) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (header) {
          current = Number(header[1]);
          continue;
        }
        if (current === null) continue;
        if (raw[0] === "-") continue;
        lines.add(current);
        current += 1;
      }
      return lines;
    };
    for (const comment of result.composed.payload.comments) {
      const file = env.fixture.files.find((entry) => entry.filename === comment.path);
      assert.ok(file, `comment on a file outside the diff: ${comment.path}`);
      const commentable = rightSideLines(file.patch);
      assert.ok(commentable.has(comment.line), `${comment.path}:${comment.line} is not in the diff`);
      if (comment.start_line) assert.ok(commentable.has(comment.start_line), `${comment.path}:${comment.start_line} is not in the diff`);
    }

    // Default policy: the model's approve never becomes an APPROVE.
    assert.equal(result.composed.event, "COMMENT");
    assert.match(result.composed.payload.body, /I would have approved this\./);
    assert.match(result.composed.payload.body, /<sub>This review was performed by a local AI bot\.<\/sub>$/);

    // The model sees the agent file, the non-interactive contract, and the skills the agent cites.
    const firstSystem = env.model.requests()[0].messages.find((message) => message.role === "system");
    const systemPrompt = Array.isArray(firstSystem?.content)
      ? firstSystem.content.map((part) => part.text ?? "").join("\n")
      : firstSystem?.content ?? "";
    assert.match(systemPrompt, /Review agent \(test\)/);
    assert.match(systemPrompt, /You are running non-interactively/);
    assert.match(systemPrompt, /demo-guidelines/);

    // The guard stopped the push attempt and recorded it.
    assert.match(env.log(), /blocked bash: git push is not permitted/);
    assert.ok(result.blocked.some((entry) => /push/.test(entry.reason)));

    // State and artifact.
    const row = env.store.getReview(result.reviewId);
    assert.equal(row.posted, 0);
    assert.equal(row.verdict, "approve");
    assert.equal(row.action, "hint");
    assert.equal(env.store.commentsFor(result.reviewId).length, SIX_COMMENTS);
    const artifact = fs.readFileSync(result.artifactPath, "utf8");
    assert.match(artifact, /## Gate runs/);
    assert.match(artifact, /go test \.\/\.\.\. \| pass/);
    assert.ok(fs.existsSync(path.join(env.dir, "reviews")));
  } finally {
    env.close();
  }
});

test("hint policy posts a COMMENT review carrying the verdict line and banner", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "none", beforePost: false } } });
  try {
    const result = await env.run();
    const [review] = env.github.postedReviews();
    assert.ok(review, "expected exactly one posted review");
    assert.equal(env.github.postedReviews().length, 1);
    assert.equal(review.state, "COMMENTED");
    assert.equal(review.commit_id, env.fixture.head.sha);
    assert.match(review.body, /I would have approved this\./);
    assert.match(review.body, /<sub>This review was performed by a local AI bot\.<\/sub>$/);
    assert.equal(review.comments.length, SIX_COMMENTS);
    assert.ok(review.comments.every((comment) => comment.side === "RIGHT"));
    assert.equal(env.store.getReview(result.reviewId).posted, 1);

    // The record has to agree with what was sent.
    assert.match(fs.readFileSync(result.artifactPath, "utf8"), /^- Posted: COMMENTED /m);
  } finally {
    env.close();
  }
});

test("approve: submit lets the verdict through as APPROVE", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false, approve: "submit" }, gate: { channel: "none", beforePost: false } } });
  try {
    const result = await env.run();
    const [review] = env.github.postedReviews();
    assert.equal(review.state, "APPROVED");
    assert.doesNotMatch(review.body, /I would have approved/);
    assert.equal(result.composed.action, "submit");
  } finally {
    env.close();
  }
});

test("request_changes stays a hint by default and names the blockers", async () => {
  const env = await setupReviewRun({
    scriptOptions: { verdict: "request_changes", blocking: ["offset skips the first page", "upstream decode error is swallowed"] },
    overrides: { reviews: { dryRun: false }, gate: { channel: "none", beforePost: false } },
  });
  try {
    const result = await env.run();
    const [review] = env.github.postedReviews();
    assert.equal(review.state, "COMMENTED");
    assert.match(review.body, /I would have requested changes\. Blocking: offset skips the first page/);
    assert.equal(result.composed.verdict, "request_changes");
    assert.equal(result.composed.action, "hint");
  } finally {
    env.close();
  }
});

test("banner rephrase keeps the configured text when the answer is not a rewrite", async () => {
  const env = await setupReviewRun({
    overrides: {
      reviews: { dryRun: false },
      banner: { rephrase: true, prefix: "I'm on leave this week; the bot answers meanwhile." },
      gate: { channel: "none", beforePost: false },
    },
  });
  try {
    const result = await env.run();
    const [review] = env.github.postedReviews();
    // The scripted model runs out of turns here, so the validator must reject the answer and the
    // configured sentence has to survive untouched.
    assert.ok(review.body.startsWith("I'm on leave this week; the bot answers meanwhile."));
    assert.match(env.log(), /banner rephrase rejected/);
    assert.equal(result.composed.payload.comments.length, SIX_COMMENTS);
  } finally {
    env.close();
  }
});

test("beforePost queues the review instead of sending it", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforePost: true } } });
  try {
    const result = await env.run();
    assert.equal(result.posted, null);
    assert.equal(result.gate.state, "queued");
    assert.equal(env.github.writes().length, 0, "a queued review must not be posted");
    const pending = env.store.pendingGates();
    assert.equal(pending.length, 1);
    assert.match(pending[0].summary, /Inline comments \(6\)/);
    assert.match(env.log(), /decide with: node src\/cli\/gate\.mjs/);

    // Approving the gate is what unlocks the post, in a later invocation of the poster.
    env.store.decideGate({ id: pending[0].id, state: "approved", decided_by: "admin" });
    assert.equal(env.store.getGate(pending[0].id).state, "approved");
  } finally {
    env.close();
  }
});

test("an approved review that cannot be posted stays queued and the loop keeps going", async () => {
  // The GitHub side refuses the write, which is what a token without pull-request access looks like.
  const env = await setupReviewRun({
    githubOptions: { writeStatus: 403 },
    overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforePost: true } },
  });
  try {
    await env.cycle();
    const pending = env.store.pendingGates();
    assert.equal(pending.length, 1);
    env.store.decideGate({ id: pending[0].id, state: "approved", decided_by: "admin" });

    await env.cycle();

    assert.match(env.log(), /repost \S+ failed: .*403/);
    assert.equal(env.store.approvedUnpostedReviews().length, 1, "the review is still waiting to go out");
    assert.match(env.log(), /cycle: /, "the cycle ran past the failed repost");
  } finally {
    env.close();
  }
});
