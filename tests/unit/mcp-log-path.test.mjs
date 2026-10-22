/**
 * The MCP extension appends to a log file, and in the container the agent directory is a read-only bind.
 * A log it cannot open is diagnostics lost, so the default follows the writable area of the run.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mcpLogFile } from "../../src/agent/runtime.mjs";

test("logging.mcpLogFile wins when it is set", () => {
  assert.equal(mcpLogFile({ logging: { mcpLogFile: "/data/mcp.log" }, checkout: { gitConfig: "/work/gitconfig" } }, "/app/.pi/agent"), "/data/mcp.log");
});

test("otherwise it follows the writable checkout area", () => {
  assert.equal(mcpLogFile({ logging: { mcpLogFile: "" }, checkout: { gitConfig: "/work/gitconfig" } }, "/app/.pi/agent"), "/work/mcp.log");
});

test("a host run with no work dir keeps it in the agent dir, which is writable there", () => {
  assert.equal(mcpLogFile({ logging: { mcpLogFile: "" }, checkout: {} }, "/home/you/repo/.pi/agent"), "/home/you/repo/.pi/agent/mcp.log");
});
