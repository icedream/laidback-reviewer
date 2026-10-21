import test from "node:test";
import assert from "node:assert/strict";
import { classifyAssignment, matchedCodeowners, parseCodeowners, isAssignedTo, repositoryFromSearchHit } from "../../src/discovery.mjs";

const me = "octocat";
const pr = (overrides = {}) => ({
  number: 1,
  created_at: "2026-04-03T10:00:00Z",
  assignees: [{ login: me }],
  ...overrides,
});
const assignedBy = (actor, at = "2026-04-03T12:00:00Z") => [{ event: "assigned", actor, assignee: { login: me }, created_at: at }];
const HUMAN = { login: "tech-lead", type: "User" };

test("any is the default and matches regardless of who set it", () => {
  const decision = classifyAssignment({ pr: pr(), events: assignedBy({ login: "mergebot[bot]", type: "Bot" }), me, policy: "any" });
  assert.equal(decision.eligible, true);
  assert.match(decision.reason, /mergebot\[bot\]/);
});

test("an assignment to someone else is never eligible", () => {
  assert.equal(isAssignedTo(pr({ assignees: [{ login: "someone-else" }] }), me), false);
  assert.equal(classifyAssignment({ pr: pr({ assignees: [{ login: "someone-else" }] }), events: [], me, policy: "any" }).eligible, false);
});

test("human_actor skips bot and organization actors", () => {
  assert.equal(classifyAssignment({ pr: pr(), events: assignedBy({ login: "ci-robot", type: "Bot" }), me, policy: "human_actor" }).eligible, false);
  assert.equal(classifyAssignment({ pr: pr(), events: assignedBy({ login: "platform-team", type: "Organization" }), me, policy: "human_actor" }).eligible, false);
  assert.equal(classifyAssignment({ pr: pr(), events: assignedBy(HUMAN), me, policy: "human_actor" }).eligible, true);
  // A timeline that does not reach back to the assignment stays eligible: absence is not evidence.
  assert.equal(classifyAssignment({ pr: pr(), events: [], me, policy: "human_actor" }).eligible, true);
});

test("exclude_codeowners only skips an assignment CODEOWNERS explains", () => {
  const codeowners = "# owners\ninternal/api/ @octocat @example/platform\n";
  const atOpen = "2026-04-03T10:00:30Z";
  const automatic = classifyAssignment({
    pr: pr(),
    events: assignedBy(HUMAN, atOpen),
    me,
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/api/orders.go"],
  });
  assert.equal(automatic.eligible, false);
  assert.match(automatic.reason, /best effort/);

  // Same rule, but a human assigned it two hours after the PR opened.
  const manual = classifyAssignment({
    pr: pr(),
    events: assignedBy(HUMAN),
    me,
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/api/orders.go"],
  });
  assert.equal(manual.eligible, true);

  // Same timing, but the changed paths are outside every rule that names me.
  const unrelated = classifyAssignment({
    pr: pr(),
    events: assignedBy(HUMAN, atOpen),
    me,
    policy: "exclude_codeowners",
    codeownersContent: codeowners,
    changedPaths: ["internal/service/orders.go"],
  });
  assert.equal(unrelated.eligible, true);
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
