/**
 * Re-reviewing a PR after a push, with the earlier look carried over.
 *
 * The scripted model keeps the turn sequence identical across runs, so anything that differs between
 * run one and run two comes from the context picker.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { setupReviewRun } from "../helpers/run-env.mjs";

function pushEmptyCommit(dir, message) {
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", message], { stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("the second run of a PR digests the first run's findings into its prompt", async () => {
  const env = await setupReviewRun({ context: { mode: "digest" } });
  try {
    const first = await env.run();
    assert.ok(first.reviewId);
    const firstSession = env.store.getReview(first.reviewId).session_file;
    assert.ok(firstSession, "a persisted session dir records the session file");

    const newHead = pushEmptyCommit(env.fixture.dir, "fix: address review feedback");
    env.github.setHead(newHead);
    env.model.resetTurns();
    const requestsBefore = env.model.requests().length;

    const second = await env.run();
    assert.notEqual(second.reviewId, first.reviewId);

    const prompt = JSON.stringify(env.model.requests().slice(requestsBefore));
    assert.match(prompt, /Continuing from an earlier look: the same PR at an earlier head, PR #143/);
    assert.match(prompt, /Check each point against the current head/);
    // The findings themselves, not a pointer to a transcript the model cannot read.
    assert.match(prompt, /internal\/(api|service)\/[a-z_]+\.go:\d+: /);
    assert.match(env.log(), /context: digest from #143 \(same_pr\)/);

    // Digest mode starts a new conversation; it does not replay the old one.
    const secondSession = env.store.getReview(second.reviewId).session_file;
    assert.notEqual(secondSession, firstSession);
    assert.ok(second.composed.payload.comments.length > 0, "the re-review still produced comments");
  } finally {
    env.close();
  }
});

test("a small earlier session is forked instead of summarised", async () => {
  const env = await setupReviewRun({ context: { mode: "auto" } });
  try {
    const first = await env.run();
    const firstSession = env.store.getReview(first.reviewId).session_file;

    const newHead = pushEmptyCommit(env.fixture.dir, "fix: second round");
    env.github.setHead(newHead);
    env.model.resetTurns();

    const second = await env.run();
    assert.match(env.log(), /context: fork from #143 \(same_pr\)/);

    const secondSession = env.store.getReview(second.reviewId).session_file;
    assert.notEqual(secondSession, firstSession);
    const firstLines = fs.readFileSync(firstSession, "utf8").trimEnd().split("\n");
    const forkLines = fs.readFileSync(secondSession, "utf8").trimEnd().split("\n");
    // Line 1 is the session header, which gets a new id and timestamp. Everything after it is the
    // earlier conversation, carried verbatim, and then the new turns on top.
    assert.deepEqual(forkLines.slice(1, 4), firstLines.slice(1, 4), "the fork starts from the earlier session");
    assert.ok(forkLines.length > firstLines.length, "and continues from it");

    const stackKey = env.store.getReview(second.reviewId).stack_key;
    assert.equal(stackKey, `example/orders-svc#143`);
  } finally {
    env.close();
  }
});

test("a re-run at the same head finds no context of its own", async () => {
  const env = await setupReviewRun({ context: { mode: "digest" }, overrides: { reviews: { rereviewOnPush: true } } });
  try {
    await env.run();
    env.model.resetTurns();
    await env.run();
    assert.match(env.log(), /context: none/);
    assert.ok(!/context: (digest|fork)/.test(env.log()), "a run at the head it already reviewed carries nothing over");
    const prompt = JSON.stringify(env.model.requests());
    assert.doesNotMatch(prompt, /Continuing from an earlier look/);
  } finally {
    env.close();
  }
});
