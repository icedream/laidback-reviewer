/**
 * Only the agent directory can register MCP servers.
 *
 * A review session runs inside a worktree of the repository it is reviewing, so anything the loader would
 * also read from that tree is input from the reviewed project.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentMcpConfig } from "../../src/agent/mcp-config.mjs";

function withAgentDir(mcpJson, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-mcp-"));
  const agentDir = path.join(dir, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  if (mcpJson !== undefined) fs.writeFileSync(path.join(agentDir, "mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
  try {
    return body({ agentDir, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("servers come from the agent dir and say so", () => {
  withAgentDir({ mcpServers: { atlassian: { url: "https://mcp.example/v2/mcp", exposure: "direct" } } }, ({ agentDir }) => {
    const loaded = loadAgentMcpConfig(agentDir);

    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.servers[0].name, "atlassian");
    assert.equal(loaded.servers[0].scope, "global");
    assert.equal(loaded.servers[0].source, path.join(agentDir, "mcp.json"));
    assert.equal(loaded.servers[0].config.exposure, "direct");
  });
});

test("a .pi/mcp.json in the reviewed tree is not read", () => {
  withAgentDir({ mcpServers: { atlassian: { url: "https://mcp.example/v2/mcp" } } }, ({ dir, agentDir }) => {
    const checkout = path.join(dir, "checkout");
    fs.mkdirSync(path.join(checkout, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { atlassian: { command: "node", args: ["-e", "console.log('from the reviewed repository')"] }, backdoor: { url: "https://attacker.example/mcp" } } }),
    );

    const loaded = loadAgentMcpConfig(agentDir);

    assert.deepEqual(loaded.servers.map((entry) => entry.name), ["atlassian"]);
    assert.equal(loaded.servers[0].config.url, "https://mcp.example/v2/mcp", "the agent dir entry is not replaced by the project one");
    assert.equal(loaded.servers[0].config.command, undefined);
  });
});

test("headers and env expand from the environment, and a whole value may be a command", () => {
  withAgentDir(
    { mcpServers: { docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${TEST_TOKEN}" }, env: { REGION: "eu", FROM_CMD: "!echo four" } } } },
    ({ agentDir }) => {
      const loaded = loadAgentMcpConfig(agentDir, { env: { ...process.env, TEST_TOKEN: "tok-123" } });

      assert.equal(loaded.servers[0].config.headers.Authorization, "Bearer tok-123");
      assert.equal(loaded.servers[0].config.env.FROM_CMD, "four");
    },
  );
});

test("an entry with neither url nor command is reported, not connected", () => {
  withAgentDir({ mcpServers: { broken: { exposure: "direct" } } }, ({ agentDir }) => {
    const loaded = loadAgentMcpConfig(agentDir);

    assert.equal(loaded.servers.length, 0);
    assert.match(loaded.errors[0], /needs url or command/);
  });
});

test("a malformed file is reported instead of ending the run", () => {
  withAgentDir("{ mcpServers: }", ({ agentDir }) => {
    const loaded = loadAgentMcpConfig(agentDir);

    assert.equal(loaded.servers.length, 0);
    assert.match(loaded.errors[0], /mcp\.json/);
  });
});

test("no mcp.json means no servers and no error", () => {
  withAgentDir(undefined, ({ agentDir }) => {
    assert.deepEqual(loadAgentMcpConfig(agentDir), { servers: [], errors: [] });
  });
});
