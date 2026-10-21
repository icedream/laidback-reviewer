#!/usr/bin/env node
/**
 * Fake Jira over MCP stdio.
 *
 * Enough of the protocol for pi's MCP client: initialize, tools/list, tools/call. It serves the
 * fixture ticket, and it also advertises a write tool so the read-only rule in the guard is tested
 * rather than assumed: the Atlassian scopes on a real token would refuse the write too, but the bot
 * must not depend on that.
 *
 * Declared by the agent dir's mcp.json, so the call path is the same one a real Atlassian server uses:
 * MCP extension, tool_call hooks, then this process.
 */

import fs from "node:fs";
import { FIXTURE_TICKET } from "../fixtures/ticket.mjs";

// Set by the test setup so the assertion can check what reached the server, which is what proves the
// read-only rule stopped the write before it got here.
const callLog = process.env.JIRA_FAKE_LOG || "";

const TOOLS = [
  {
    name: "getJiraIssue",
    description: "Read one Jira issue: summary, description, status, issue links.",
    inputSchema: {
      type: "object",
      properties: { issueIdOrKey: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
      required: ["issueIdOrKey"],
    },
    readOnly: true,
  },
  {
    name: "searchJiraIssues",
    description: "Search issues with JQL.",
    inputSchema: { type: "object", properties: { jql: { type: "string" } }, required: ["jql"] },
    readOnly: true,
  },
  {
    name: "addComment",
    description: "Add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: { issueIdOrKey: { type: "string" }, body: { type: "string" } },
      required: ["issueIdOrKey", "body"],
    },
  },
];

const called = [];

function callTool(name, args) {
  called.push({ name, args });
  if (callLog) fs.appendFileSync(callLog, `${JSON.stringify({ name, args })}\n`);
  if (name === "getJiraIssue") {
    if (args.issueIdOrKey !== FIXTURE_TICKET.key) {
      return { content: [{ type: "text", text: `{"error":"issue not found: ${args.issueIdOrKey}"}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(FIXTURE_TICKET) }] };
  }
  if (name === "searchJiraIssues") {
    return { content: [{ type: "text", text: JSON.stringify({ issues: [FIXTURE_TICKET] }) }] };
  }
  if (name === "addComment") {
    return { content: [{ type: "text", text: JSON.stringify({ written: true, issue: args.issueIdOrKey }) }] };
  }
  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
// The MCP client closes this process by closing its stdin; exiting on end keeps a finished test run
// from holding an open pipe.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // notifications carry no id

    switch (message.method) {
      case "initialize":
        reply(message.id, {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake-jira", version: "0.1.0" },
        });
        break;
      case "ping":
        reply(message.id, {});
        break;
      case "tools/list":
        reply(message.id, { tools: TOOLS });
        break;
      case "tools/call":
        reply(message.id, callTool(message.params?.name, message.params?.arguments ?? {}));
        break;
      default:
        fail(message.id, `unsupported method ${message.method}`);
    }
  }
});

process.stderr.write(`fake-jira serving ${FIXTURE_TICKET.key}\n`);
