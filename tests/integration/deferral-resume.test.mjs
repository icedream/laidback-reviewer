/**
 * A deferred head comes back to the session it was interrupted in.
 *
 * The fork has to carry the run's own work, not just what the harness re-injects: if the model's earlier
 * tool calls and their output are gone, a deferral is a restart with extra steps.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { setupReviewRun } from "../helpers/run-env.mjs";
import { reviewScript } from "../fakes/model.mjs";

// Something only the agent's own shell produces. Nothing in the task prompt or the PR mentions it, so
// finding it in the next run's messages can only mean the transcript came along.
const MARKER = "scratch-probe-8f31c0";

test("a resumed run carries what the interrupted run found out", async () => {
  const env = await setupReviewRun({
    context: { enabled: true },
    turns: (fixture, dir) => [
      { content: "Measuring before judging.", tool_calls: [{ name: "bash", args: { command: `echo ${MARKER} && git log --oneline -1` } }] },
      ...reviewScript({ fixture, scratchDir: dir }),
    ],
    overrides: { reviews: { dryRun: true }, gate: { channel: "cli", beforeReview: false, beforePost: false } },
  });
  try {
    const first = await env.run();
    const sessionFile = env.store.getReview(first.reviewId).session_file;
    assert.ok(sessionFile && fs.existsSync(sessionFile), "the interrupted pass leaves a transcript behind");
    const firstRequests = env.model.requests().length;

    env.model.resetTurns();
    const second = await env.run({ manual: true, resumeSessionFile: sessionFile, resumedAt: "2026-04-04T09:00:00.000Z" });
    assert.ok(second.reviewId, "the resumed run composes a review");

    const resumed = env.model.requests().slice(firstRequests);
    assert.ok(resumed.length, "the resumed run talked to the model");
    const carried = JSON.stringify(resumed[0].messages);
    assert.match(carried, new RegExp(MARKER), "the earlier tool call and its output are in the prompt");
    assert.match(carried, /refactor: list orders through a service client/, "so is the git output the run collected");
    assert.match(carried, /Resumed run/, "and the task prompt says it is a continuation");
  } finally {
    env.close();
  }
});
