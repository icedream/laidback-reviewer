#!/usr/bin/env node
/**
 * Entry point: load configuration, prove the credential's scope, then hand the polling loop to
 * loop.mjs.
 */

import { loadConfig, secret } from "./config.mjs";
import { createGithubClient } from "./github/client.mjs";
import { describeScope } from "./github/scope.mjs";
import { createSlackGate } from "./gate/slack.mjs";
import { runLoop } from "./loop.mjs";
import { openStore } from "./proposal/store.mjs";

function startupSummary({ cfg, store }) {
  const failures = store.listFailures().filter((row) => row.parked);
  console.log(
    [
      `laidback-reviewer watching ${cfg.github.me}`,
      `  scope: ${describeScope(cfg.github)}`,
      `  trigger: ${cfg.trigger.mode}; provenance policy: ${cfg.trigger.policy}`,
      `  model: ${cfg.agent.model.provider}/${cfg.agent.model.id} (thinking ${cfg.agent.model.thinking}, ${cfg.agent.model.busyRetries} busy retries at ${cfg.agent.model.busyBackoffMs}ms)`,
      `  agent: ${cfg.agent.name} from ${cfg.agent.agentDir}`,
      `  verdict policy: approve=${cfg.reviews.approve} request_changes=${cfg.reviews.requestChanges}`,
      `  posting: ${cfg.reviews.dryRun ? "DRY RUN, nothing is sent" : "live"}; gate: ${cfg.gate.channel} (before_review ${cfg.gate.beforeReview}, before_post ${cfg.gate.beforePost})`,
      `  writes: POST /repos/<owner>/<repo>/pulls/<n>/reviews only; any other write is refused locally`,
      `  retries: ${cfg.reviews.maxAttemptsPerHead} attempts per head, spaced from ${cfg.reviews.retryBaseMs}ms to ${cfg.reviews.retryMaxMs}ms`,
      `  tools: read/grep/find/ls${cfg.tools.bash ? " + bash" : ""}, mcp: ${cfg.tools.mcp.join(", ") || "none"}, hosts: ${cfg.tools.allowHosts.join(", ")}`,
      `  state: ${process.env.LAIDBACK_STATE_DB ?? "data/state.db"}, cursor: ${store.getMeta("search_updated_at") ?? "unset"}`,
      ...(failures.length ? [`  parked: ${failures.map((row) => `${row.owner}/${row.repo}#${row.pr}`).join(", ")}`] : []),
    ].join("\n"),
  );
}

async function main() {
  const cfg = loadConfig();
  for (const note of cfg._deprecations ?? []) console.log(`config: ${note}`);
  secret(cfg, cfg.github.tokenEnv, { required: true });
  const store = openStore(process.env.LAIDBACK_STATE_DB ?? "data/state.db");
  const client = createGithubClient({
    baseUrl: process.env.LAIDBACK_GH_API || "https://api.github.com",
    token: secret(cfg, cfg.github.tokenEnv),
  });

  let slack = null;
  if (cfg.gate.channel === "slack") {
    const token = secret(cfg, cfg.gate.slack.tokenEnv);
    const cookie = secret(cfg, cfg.gate.slack.cookieEnv);
    if (!token) console.log(`gate.channel=slack but ${cfg.gate.slack.tokenEnv} is unset: gates stay queued`);
    else slack = createSlackGate({ cfg, store, token, cookie, log: (line) => console.log(`  ${line}`) });
  }

  startupSummary({ cfg, store });

  const stop = { current: false };
  process.on("SIGINT", () => {
    console.log("stopping after the current cycle");
    stop.current = true;
  });

  await runLoop({ cfg, store, client, slack, stop });
  store.close();
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
