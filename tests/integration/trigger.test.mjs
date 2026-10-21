/** Which trigger the fake GitHub reports, and what the bot makes of it. */

import assert from "node:assert/strict";
import test from "node:test";
import { findCandidates } from "../../src/discovery.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";

const TEAM = [{ slug: "platform", type: "Team" }];
const ME = [{ login: "octocat", type: "User" }];
const teamEvent = {
  event: "review_requested",
  actor: { login: "tech-lead", type: "User" },
  requested_team: { slug: "platform", type: "Team" },
  created_at: "2026-04-03T11:24:00Z",
};

const queries = (env) => env.github.calls().filter((call) => call.path === "/search/issues").map((call) => call.query?.q ?? "");

test("a team review request does not reach the candidate list", async () => {
  const env = await setupReviewRun({
    prState: { requestedReviewers: [], requestedTeams: TEAM, assignees: ME, timeline: [teamEvent] },
  });
  try {
    const { candidates } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 0, "the request went to the team, not to me");
    const [query] = queries(env);
    assert.match(query, /review-requested:octocat/);
    assert.doesNotMatch(query, /@/);
    assert.equal(env.github.calls().length, 1, "and no pull was fetched for a request that is not mine");
  } finally {
    env.close();
  }
});

test("an assignment without a review request does not trigger the default mode", async () => {
  const env = await setupReviewRun({ prState: { requestedReviewers: [], requestedTeams: [], assignees: ME } });
  try {
    const { candidates } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });
    assert.equal(candidates.length, 0);
  } finally {
    env.close();
  }
});

test("trigger.mode: both takes the assignment, and says which path found it", async () => {
  const env = await setupReviewRun({
    overrides: { trigger: { mode: "both" } },
    prState: { requestedReviewers: [], requestedTeams: [], assignees: ME },
  });
  try {
    const { candidates } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 1);
    assert.match(candidates[0].reason, /assigned to me/);
    const asked = env.github.calls().filter((call) => call.path === "/search/issues").map((call) => call.query?.q ?? "");
    assert.equal(asked.length, 2, "one query per qualifier, search cannot OR them");
    assert.ok(asked.some((q) => q.includes("review-requested:octocat")));
    assert.ok(asked.some((q) => q.includes("assignee:octocat")));
  } finally {
    env.close();
  }
});

test("assignee and requested reviewer is one candidate, from the request", async () => {
  const env = await setupReviewRun({
    overrides: { trigger: { mode: "both" } },
    prState: { requestedReviewers: ME, assignees: ME },
  });
  try {
    const { candidates } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 1, "the two queries must not review the same head twice");
    assert.match(candidates[0].reason, /review requested to me/);
  } finally {
    env.close();
  }
});

test("the review request path runs the review", async () => {
  const env = await setupReviewRun();
  try {
    const { candidates } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 1);
    assert.match(candidates[0].reason, /review requested to me \(tech-lead\)/);

    await env.cycle();
    assert.equal(env.store.db.prepare("SELECT COUNT(*) AS n FROM reviews").get().n, 1, "a review row was composed");
    assert.deepEqual(env.github.writes(), [], "dry run still posts nothing");
  } finally {
    env.close();
  }
});
