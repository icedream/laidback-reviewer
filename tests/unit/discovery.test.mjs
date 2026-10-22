/** Trigger kind and provenance policy, including the team-request case. */

import test from "node:test";
import assert from "node:assert/strict";
import { baseConfig } from "../helpers/run-env.mjs";
import {
  classifyTrigger,
  isAssignedTo,
  isRequestedReviewer,
  matchedCodeowners,
  parseCodeowners,
  repositoryFromSearchHit,
  findCandidates,
} from "../../src/discovery.mjs";

const me = "octocat";
const HUMAN = { login: "tech-lead", type: "User" };

const pr = (overrides = {}) => ({
  number: 1,
  created_at: "2026-04-03T10:00:00Z",
  assignees: [{ login: me }],
  requested_reviewers: [{ login: me, type: "User" }],
  requested_teams: [],
  ...overrides,
});
const assignedBy = (actor, at = "2026-04-03T12:00:00Z") => [{ event: "assigned", actor, assignee: { login: me }, created_at: at }];
const requestedFrom = (actor, at = "2026-04-03T12:00:00Z") => [
  { event: "review_requested", actor, requested_reviewer: { login: me, type: "User" }, created_at: at },
];
const teamRequest = (actor, slug = "platform", at = "2026-04-03T12:00:00Z") => [
  { event: "review_requested", actor, requested_team: { slug, type: "Team" }, created_at: at },
];

const asReviewer = (args) => classifyTrigger({ me, kind: "review_requested", ...args });
const asAssignee = (args) => classifyTrigger({ me, kind: "assigned", ...args });

test("an individual review request is the default trigger", () => {
  assert.equal(isRequestedReviewer(pr(), me), true);
  const decision = asReviewer({ pr: pr(), events: requestedFrom(HUMAN), policy: "any" });
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /review requested to me \(tech-lead\)/);
});

test("a request to a team I belong to is not a request to me", () => {
  // The shape GitHub returns when CODEOWNERS or a human names a team: the team is the reviewer, and
  // I am still listed as an assignee because I own the touched paths.
  const teamOnly = pr({ requested_reviewers: [], requested_teams: [{ slug: "platform", type: "Team" }] });
  assert.equal(isRequestedReviewer(teamOnly, me), false);

  const decision = asReviewer({ pr: teamOnly, events: teamRequest(HUMAN), policy: "any" });
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /not an individually requested reviewer/);
  assert.match(decision.reason, /teams: platform/);
});

test("an assignment with no review request does not trigger the reviewer path", () => {
  const assigned = pr({ requested_reviewers: [] });
  assert.equal(asReviewer({ pr: assigned, events: assignedBy(HUMAN), policy: "any" }).eligible, false);
  // The same PR is eligible when the operator asked for assignment triggers as well.
  assert.equal(asAssignee({ pr: assigned, events: assignedBy(HUMAN), policy: "any" }).eligible, true);
});

test("being assignee and requested reviewer triggers once, on the request", () => {
  const both = pr();
  assert.equal(asReviewer({ pr: both, events: [...teamRequest(HUMAN), ...requestedFrom(HUMAN)], policy: "any" }).eligible, true);
  assert.equal(asAssignee({ pr: both, events: assignedBy(HUMAN), policy: "any" }).eligible, true);
});

test("a team request in the timeline does not stand in for my request", () => {
  // Only my own request event counts as provenance: the team event is by a bot and would otherwise
  // fail human_actor on its own.
  const decision = asReviewer({
    pr: pr(),
    events: [...teamRequest({ login: "ci-robot", type: "Bot" }), ...requestedFrom(HUMAN)],
    policy: "human_actor",
  });
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /by tech-lead/);
});

test("the requester decides, not the PR author", () => {
  const botAuthored = pr({ user: { login: "dependabot[bot]", type: "Bot" } });
  assert.equal(asReviewer({ pr: botAuthored, events: requestedFrom(HUMAN), policy: "human_actor" }).eligible, true);
  // Asking myself is a request from a person.
  assert.equal(asReviewer({ pr: botAuthored, events: requestedFrom({ login: me, type: "User" }), policy: "human_actor" }).eligible, true);
  // The dependabot shape: the bot authored the PR and filed the request itself.
  const byBot = asReviewer({ pr: botAuthored, events: requestedFrom({ login: "dependabot[bot]", type: "Bot" }), policy: "human_actor" });
  assert.equal(byBot.eligible, false);
  assert.match(byBot.reason, /only by automation actors \(dependabot\[bot\]\)/);
});

test("a human request survives a later automation re-request", () => {
  const bot = { login: "ci-robot", type: "Bot" };
  assert.equal(asReviewer({ pr: pr(), events: [...requestedFrom(HUMAN, "2026-04-03T11:00:00Z"), ...requestedFrom(bot)], policy: "human_actor" }).eligible, true);
  const assigned = [...assignedBy(HUMAN, "2026-04-03T11:00:00Z"), ...assignedBy(bot)];
  assert.equal(asAssignee({ pr: pr(), events: assigned, policy: "human_actor" }).eligible, true);
});

test("any is the default and matches regardless of who set it", () => {
  const decision = asAssignee({ pr: pr(), events: assignedBy({ login: "mergebot[bot]", type: "Bot" }), policy: "any" });
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /mergebot\[bot\]/);
});

test("an assignment to someone else is never eligible", () => {
  assert.equal(isAssignedTo(pr({ assignees: [{ login: "someone-else" }] }), me), false);
  assert.equal(asAssignee({ pr: pr({ assignees: [{ login: "someone-else" }] }), events: [], policy: "any" }).eligible, false);
});

test("human_actor skips bot and organization actors", () => {
  assert.equal(asAssignee({ pr: pr(), events: assignedBy({ login: "ci-robot", type: "Bot" }), policy: "human_actor" }).eligible, false);
  assert.equal(
    asAssignee({ pr: pr(), events: assignedBy({ login: "platform-team", type: "Organization" }), policy: "human_actor" }).eligible,
    false,
  );
  assert.equal(asAssignee({ pr: pr(), events: assignedBy(HUMAN), policy: "human_actor" }).eligible, true);
  // A timeline that does not reach back to the assignment stays eligible: absence is not evidence.
  assert.equal(asAssignee({ pr: pr(), events: [], policy: "human_actor" }).eligible, true);
});

test("exclude_codeowners only skips a trigger CODEOWNERS explains", () => {
  const codeowners = "# owners\ninternal/api/ @octocat @example/platform\n";
  const atOpen = "2026-04-03T10:00:30Z";
  const automatic = asAssignee({
    pr: pr(),
    events: assignedBy(HUMAN, atOpen),
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/api/orders.go"],
  });
  assert.equal(automatic.eligible, false);
  assert.match(automatic.reason, /best effort/);

  // Same rule, but a human assigned it two hours after the PR opened.
  const manual = asAssignee({
    pr: pr(),
    events: assignedBy(HUMAN),
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/api/orders.go"],
  });
  assert.equal(manual.eligible, true);

  // Same timing, but the changed paths are outside every rule that names me.
  const unrelated = asAssignee({
    pr: pr(),
    events: assignedBy(HUMAN, atOpen),
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/service/orders.go"],
  });
  assert.equal(unrelated.eligible, true);

  // The reviewer path carries the same reasoning for a code-owner request GitHub filed at PR open.
  const automaticRequest = asReviewer({
    pr: pr(),
    events: requestedFrom(HUMAN, atOpen),
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/api/orders.go"],
  });
  assert.equal(automaticRequest.eligible, false);
  assert.match(automaticRequest.reason, /review requested matches a CODEOWNERS rule/);
});

test("CODEOWNERS parsing ignores comments and blank lines", () => {
  const rules = parseCodeowners("# comment\n\n* @owner-one\n\ndocs/ @owner-two @org/team\n");
  assert.deepEqual(rules, [
    { pattern: "*", owners: ["@owner-one"] },
    { pattern: "docs/", owners: ["@owner-two", "@org/team"] },
  ]);
});

test("path matching distinguishes a bare wildcard from a directory rule", () => {
  assert.equal(matchedCodeowners(parseCodeowners("docs/ @me"), ["internal/api/x.go"]).length, 0);
  assert.equal(matchedCodeowners(parseCodeowners("docs/ @me"), ["docs/readme.md"]).length, 1);
  assert.equal(matchedCodeowners(parseCodeowners("*.go @me"), ["a/b/c.go"]).length, 1);
  assert.equal(matchedCodeowners(parseCodeowners("internal/** @me"), ["internal/a/b.go"]).length, 1);
});

test("search hits resolve to owner, repo and number", () => {
  assert.deepEqual(
    repositoryFromSearchHit({ repository_url: "https://api.github.com/repos/example/orders-svc", number: 143 }),
    { owner: "example", repo: "orders-svc", number: 143 },
  );
  assert.equal(repositoryFromSearchHit({ number: 1 }), null);
});

test("the search window reaches back over the stored cursor", async () => {
  // GitHub's `updated:` qualifier and the cursor meet at second precision, so a PR can be updated in the
  // same second the cursor records and then fall out of the next window.
  const cfg = baseConfig({ dir: "/tmp" });
  const searches = [];
  const client = {
    searchReviewRequested: async ({ sinceIso }) => {
      searches.push(sinceIso);
      return { items: [] };
    },
    searchAssigned: async ({ sinceIso }) => {
      searches.push(sinceIso);
      return { items: [] };
    },
  };
  const store = { getMeta: () => "2026-04-03T11:24:00.000Z", setMeta: () => {} };

  const found = await findCandidates({ cfg, client, store, now: new Date("2026-04-03T12:00:00Z") });

  assert.equal(cfg.github.cursorOverlapMs, 120_000);
  assert.deepEqual(searches, ["2026-04-03T11:22:00.000Z"], "the window overlaps the boundary");
  assert.equal(found.cursorIso, "2026-04-03T11:24:00.000Z", "the stored cursor does not drift backwards");
});
