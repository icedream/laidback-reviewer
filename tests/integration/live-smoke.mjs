#!/usr/bin/env node
/**
 * Live smoke run: the fixture repository, the fake GitHub API, and a real model with the real review
 * agent. This is the "show me how the bot would review it" command.
 *
 *   STRATA_API_KEY is read from the agent dir's models.json, never passed on the command line:
 *   node tests/integration/live-smoke.mjs
 *
 * It always runs dry. What it prints is exactly what the policy would send.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../../src/config.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { createGithubClient } from "../../src/github/client.mjs";
import { createFakeGithubApi } from "../fakes/github-api.mjs";
import { buildFixtureRepo } from "../fixtures/repo.mjs";
import { baseConfig } from "../helpers/run-env.mjs";
import { runReview } from "../../src/review-run.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const hostAgentDir = arg("agent-dir", path.join(os.homedir(), ".pi", "agent"));
const provider = arg("provider", process.env.LAIDBACK_MODEL_PROVIDER ?? "local/strata");
const modelId = arg("model", process.env.LAIDBACK_MODEL_ID ?? "qwen3.8-flash-next-iq3_s");
const thinking = arg("thinking", "xhigh");
const agentName = arg("agent", "pr-review");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-smoke-"));
fs.mkdirSync(path.join(dir, "scratch"), { recursive: true });

const agentDir = path.join(dir, "agent");
fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
const modelsSource = path.join(hostAgentDir, "models.json");
if (!fs.existsSync(modelsSource)) {
  console.error(`no models.json in ${hostAgentDir}: point --agent-dir at a Pi agent dir that can reach the model`);
  process.exit(1);
}
fs.copyFileSync(modelsSource, path.join(agentDir, "models.json"));
if (fs.existsSync(path.join(hostAgentDir, "agents"))) {
  fs.cpSync(path.join(hostAgentDir, "agents"), path.join(agentDir, "agents"), { recursive: true, dereference: true });
}

// Ticket access for the smoke run. "fake" (default) serves the fixture ticket over stdio, so the run
// shows the requirement checklist and the unimplemented criterion without touching a real tracker.
// "real" copies the host agent dir's mcp.json and its OAuth cache instead.
const jiraMode = arg("jira", "fake");
if (jiraMode === "fake") {
  fs.writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          atlassian: {
            transport: "stdio",
            command: process.execPath,
            args: [new URL("../fakes/jira-mcp.mjs", import.meta.url).pathname],
            env: { JIRA_FAKE_LOG: path.join(dir, "jira-calls.jsonl") },
            exposure: "direct",
          },
        },
      },
      null,
      2,
    ),
  );
} else if (fs.existsSync(path.join(hostAgentDir, "mcp.json"))) {
  fs.copyFileSync(path.join(hostAgentDir, "mcp.json"), path.join(agentDir, "mcp.json"));
  if (fs.existsSync(path.join(hostAgentDir, "mcp-auth.json"))) {
    fs.copyFileSync(path.join(hostAgentDir, "mcp-auth.json"), path.join(agentDir, "mcp-auth.json"));
  }
}

const fixture = buildFixtureRepo({ dir: path.join(dir, "repos", "orders-svc") });
const github = createFakeGithubApi({ fixture, me: "octocat", token: "smoke-token" });
const { baseUrl: githubBaseUrl } = await github.start();

const tree = baseConfig({ dir });
tree.github.me = "octocat";
tree.github.tokenEnv = "LAIDBACK_SMOKE_TOKEN";
tree.agent = { ...tree.agent, name: agentName, agentDir: path.join(agentDir, "agents"), skillsDir: arg("skills-dir", path.join(os.homedir(), ".agents", "skills")), model: { provider, id: modelId, thinking, maxConcurrency: 1, busyBackoffMs: 0 } };
tree.reviews = { ...tree.reviews, dryRun: true };
tree.gate = { ...tree.gate, channel: "none", beforePost: false };
tree.tools = { ...tree.tools, mcp: jiraMode === "fake" ? ["atlassian"] : [], allowHosts: ["127.0.0.1", "github.com", "api.github.com"] };
tree.checkout = { ...tree.checkout, mode: "existing", existingDir: fixture.dir };
const configPath = path.join(dir, "config.yaml");
fs.writeFileSync(configPath, stringify(tree));
const cfg = loadConfig({ path: configPath, env: { LAIDBACK_SMOKE_TOKEN: "smoke-token" } });

const store = openStore(path.join(dir, "state.db"));
const client = createGithubClient({ baseUrl: githubBaseUrl, token: "smoke-token" });

console.log(`model ${provider}/${modelId} (thinking ${thinking}), agent ${agentName}`);
console.log(`fixture ${fixture.dir}, head ${fixture.head.sha.slice(0, 8)}, ${fixture.files.length} files`);
console.log(`planted issues: ${fixture.planted.map((item) => item.id).join(", ")}`);
console.log(`ticket access: ${jiraMode}`);

const started = Date.now();
let result;
try {
  result = await runReview({
    cfg,
    store,
    client,
    task: { owner: fixture.owner, repo: fixture.repo, pr: fixture.pr, checkoutDir: fixture.dir },
    piAgentDir: agentDir,
    artifactDir: path.join(dir, "reviews"),
  });
} catch (error) {
  console.error(`smoke run failed: ${error.message}`);
  process.exitCode = 1;
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
if (result) {
  console.log(`\n--- review body (${result.composed.event}, action ${result.composed.action}, ${seconds}s) ---\n`);
  console.log(result.composed.payload.body);
  console.log(`\n--- inline comments (${result.composed.payload.comments.length}) ---\n`);
  for (const comment of result.composed.payload.comments) {
    console.log(`${comment.path}:${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}`);
    console.log(`  ${comment.body.replace(/\n+/g, " ")}\n`);
  }
  if (result.composed.notes.length) console.log(`harness notes:\n  ${result.composed.notes.join("\n  ")}`);
  if (result.blocked.length) console.log(`blocked tool calls: ${result.blocked.map((entry) => `${entry.tool}: ${entry.reason}`).join("; ")}`);
  console.log(`\nrecord: ${result.artifactPath}`);

  // Structural checks only. Review quality is for a human to judge from the printout above.
  const checks = [
    ["a verdict was recorded", !!result.composed.verdict],
    ["at least one inline comment", result.composed.payload.comments.length > 0],
    ["a body-level finding was written", (result.composed.payload.body ?? "").length > 80],
    ["the review stayed a comment (dry run + hint policy)", result.composed.event === "COMMENT"],
    ["nothing was written to GitHub", github.writes().length === 0],
    ["only known API paths were requested", github.violations().length === 0],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

store.close();
github.close();
console.log(`\ntmp tree kept for inspection: ${dir}`);
