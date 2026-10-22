#!/usr/bin/env node
/**
 * Entry point: load configuration, prove the credential's scope, then hand the polling loop to
 * loop.mjs.
 */

import { loadConfig, secret } from "./config.mjs";
import { createGithubClient } from "./github/client.mjs";
import { describeScope } from "./github/scope.mjs";
import { gateTransportFromConfig } from "./gate/transport.mjs";
import { runLoop } from "./loop.mjs";
import { openStore } from "./proposal/store.mjs";

function startupSummary({ cfg, store }) {
  const failures = store.listFailures().filter((row) => row.parked);
  const deferrals = store.activeDeferrals();
  console.log(
    [
      `laidback-reviewer watching ${cfg.github.me}`,
      `  scope: ${describeScope(cfg.github)}`,
      `  trigger: ${cfg.trigger.mode}; provenance policy: ${cfg.trigger.policy}`,
      `  model: ${cfg.agent.model.provider}/${cfg.agent.model.id} (thinking ${cfg.agent.model.thinking}, ${cfg.agent.model.busyRetries} busy retries at ${cfg.agent.model.busyBackoffMs}ms, queue probe ${cfg.agent.model.probe})`,
      `  agent: ${cfg.agent.name} from ${cfg.agent.agentDir}`,
      `  verdict policy: approve=${cfg.reviews.approve} request_changes=${cfg.reviews.requestChanges}`,
      `  posting: ${cfg.reviews.dryRun ? "DRY RUN, nothing is sent" : "live"}; gate: ${cfg.gate.channel} (before_review ${cfg.gate.beforeReview}, before_post ${cfg.gate.beforePost})`,
      `  writes: POST /repos/<owner>/<repo>/pulls/<n>/reviews only; any other write is refused locally`,
      `  retries: ${cfg.reviews.maxAttemptsPerHead} attempts per head, spaced from ${cfg.reviews.retryBaseMs}ms to ${cfg.reviews.retryMaxMs}ms`,
      `  progress: ${cfg.logging.progress} (heartbeat every ${Math.round(cfg.logging.heartbeatMs / 1000)}s), logging ${cfg.logging.level}, one review budget ${Math.round(cfg.reviews.budgetMs / 60000)}m`,
      `  tools: read/grep/find/ls${cfg.tools.bash ? " + bash" : ""}, mcp: ${cfg.tools.mcp.join(", ") || "none"}, hosts: ${cfg.tools.allowHosts.join(", ")}`,
      `  state: ${process.env.LAIDBACK_STATE_DB ?? "data/state.db"}, cursor: ${store.getMeta("search_updated_at") ?? "unset"}`,
      ...(failures.length ? [`  parked: ${failures.map((row) => `${row.owner}/${row.repo}#${row.pr}`).join(", ")}`] : []),
      ...(deferrals.length ? [`  deferred: ${deferrals.map((row) => `${row.owner}/${row.repo}#${row.pr} until ${row.until_at.slice(11, 16)}`).join(", ")}`] : []),
    ].join("\n"),
  );
}

async function main() {
  const cfg = loadConfig();
  if (process.argv.includes("--debug") || process.env.LAIDBACK_DEBUG) {
    cfg.logging.level = "debug";
    cfg.logging.progress = "full";
  }
  for (const note of cfg._deprecations ?? []) console.log(`config: ${note}`);
  secret(cfg, cfg.github.tokenEnv, { required: true });
  const store = openStore(process.env.LAIDBACK_STATE_DB ?? "data/state.db");
  const client = createGithubClient({
    baseUrl: process.env.LAIDBACK_GH_API || "https://api.github.com",
    token: secret(cfg, cfg.github.tokenEnv),
    timeoutMs: cfg.github.timeoutMs,
  });

  const transport = gateTransportFromConfig({ cfg, store, log: (line) => console.log(`  ${line}`) });

  startupSummary({ cfg, store });

  const stop = { current: false };
  process.on("SIGINT", () => {
    console.log("stopping after the current cycle");
    stop.current = true;
  });

  await runLoop({ cfg, store, client, transport, stop });
  store.close();
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
