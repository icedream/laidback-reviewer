/**
 * The settle window between a session existing and its MCP tools existing.
 *
 * A server that connects late is a degraded review, not a failed one, so the wait has to bound itself and
 * report what it could not find rather than throwing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { waitForMcpTools } from "../../src/agent/mcp-settle.mjs";

/** Hands back the snapshots in order, repeating the last one. */
function fakeSession(snapshots) {
  let call = 0;
  const session = { getActiveToolNames: () => snapshots[Math.min(call++, snapshots.length - 1)] };
  Object.defineProperty(session, "polls", { get: () => call });
  return session;
}

test("waits for the server's tools to land", async () => {
  const session = fakeSession([[], [], ["read", "mcp__atlassian__getJiraIssue"]]);

  const result = await waitForMcpTools({ session, servers: ["atlassian"], timeoutMs: 5_000, pollMs: 20 });

  assert.deepEqual(result.ready, ["atlassian"]);
  assert.deepEqual(result.missing, []);
  assert.equal(result.settled, true);
  assert.ok(session.polls >= 3, `expected at least three looks at the tool list, got ${session.polls}`);
});

test("a server that never connects degrades instead of failing the run", async () => {
  const session = fakeSession([[]]);

  const result = await waitForMcpTools({ session, servers: ["atlassian"], timeoutMs: 150, pollMs: 30 });

  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.missing, ["atlassian"]);
  assert.equal(result.settled, false);
  assert.ok(result.waitedMs >= 150, `the deadline was honoured: ${result.waitedMs}ms`);
});

test("one server ready and one absent reports the difference", async () => {
  const session = fakeSession([["mcp__atlassian__getJiraIssue"]]);

  const result = await waitForMcpTools({ session, servers: ["atlassian", "jira-cloud"], timeoutMs: 120, pollMs: 30 });

  assert.deepEqual(result.ready, ["atlassian"]);
  assert.deepEqual(result.missing, ["jira-cloud"]);
});

test("a dashed server name still matches its namespace", async () => {
  const session = fakeSession([["mcp__jira_cloud__searchJiraIssuesUsingJql"]]);

  const result = await waitForMcpTools({ session, servers: ["jira-cloud"], timeoutMs: 1_000, pollMs: 10 });

  assert.deepEqual(result.ready, ["jira-cloud"]);
  assert.deepEqual(result.missing, []);
});

test("nothing configured means no waiting", async () => {
  const result = await waitForMcpTools({ session: fakeSession([[]]), servers: [], timeoutMs: 8_000 });

  assert.equal(result.waitedMs, 0);
  assert.deepEqual(result.missing, []);
});

test("a zero budget asks the session once and moves on", async () => {
  const session = fakeSession([[], ["mcp__atlassian__getJiraIssue"]]);

  const result = await waitForMcpTools({ session, servers: ["atlassian"], timeoutMs: 0 });

  assert.deepEqual(result.missing, ["atlassian"]);
  assert.equal(result.waitedMs, 0);
});
