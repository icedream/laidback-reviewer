#!/usr/bin/env node
/**
 * Poll loop: find pull requests assigned to me, review them, and stop short of anything the policy
 * or the gate has not allowed.
 *
 * One review at a time. A single local inference server holds one prompt, and the model behind this
 * bot is the same one interactive sessions use, so overlapping runs would fail rather than queue.
 */

import { loadConfig, secret } from "./config.mjs";
import { prepareCheckout, releaseWorktree } from "./checkout.mjs";
import { findCandidates } from "./discovery.mjs";
import { createGithubClient } from "./github/client.mjs";
import { probeContentsReadOnly } from "./github/token-probe.mjs";
import { createSlackGate } from "./gate/slack.mjs";
import { openStore } from "./proposal/store.mjs";
import { postApprovedReview } from "./proposal/repost.mjs";
import { runReview } from "./review-run.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startupSummary({ cfg, store }) {
  console.log(
    [
      `laidback-reviewer watching assignee=${cfg.github.me}`,
      `  scope: ${cfg.github.orgs.join(", ") || "any"}${cfg.github.repos.length ? ` + ${cfg.github.repos.join(", ")}` : ""}`,
      `  assignment policy: ${cfg.assignment.policy}, review requests: ${cfg.assignment.includeReviewRequests}`,
      `  model: ${cfg.agent.model.provider}/${cfg.agent.model.id} (thinking ${cfg.agent.model.thinking})`,
      `  agent: ${cfg.agent.name} from ${cfg.agent.agentDir}`,
      `  verdict policy: approve=${cfg.reviews.approve} request_changes=${cfg.reviews.requestChanges}`,
      `  posting: ${cfg.reviews.dryRun ? "DRY RUN, nothing is sent" : "live"}; gate: ${cfg.gate.channel} (before_review ${cfg.gate.beforeReview}, before_post ${cfg.gate.beforePost})`,
      `  tools: read/grep/find/ls${cfg.tools.bash ? " + bash" : ""}, mcp: ${cfg.tools.mcp.join(", ") || "none"}, hosts: ${cfg.tools.allowHosts.join(", ")}`,
      `  state: ${process.env.LAIDBACK_STATE_DB ?? "data/state.db"}, cursor: ${store.getMeta("search_updated_at") ?? "unset"}`,
    ].join("\n"),
  );
}

async function cycle({ cfg, store, client, slack }) {
  if (slack) {
    slack.expire();
    const decided = await slack.readDecisions();
    for (const gate of decided) console.log(`gate ${gate.id} ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
  }

  // Reviews an admin approved between cycles go out now, re-anchored against the current head.
  for (const reviewId of store.approvedUnpostedReviews()) {
    await postApprovedReview({ cfg, store, client, reviewId, log: (line) => console.log(`  ${line}`) });
  }

  const { candidates, deferred, rejected, cursorIso } = await findCandidates({ cfg, client, store });
  console.log(`cycle: ${candidates.length} candidate(s) since ${cursorIso.slice(0, 16)}${rejected.length ? `, ${rejected.length} rejected` : ""}${deferred.length ? `, ${deferred.length} deferred to the next cycle` : ""}`);
  for (const item of rejected) console.log(`  skip ${item.pr}: ${item.reason}`);

  for (const candidate of candidates) {
    console.log(`  candidate ${candidate.htmlUrl}: ${candidate.reason}`);
    let checkout = null;
    try {
      checkout = prepareCheckout({
        cfg,
        owner: candidate.owner,
        repo: candidate.repo,
        pr: candidate.pr,
        headRef: candidate.headRef,
        headSha: candidate.headSha,
        log: (line) => console.log(`    ${line}`),
      });
      const result = await runReview({
        cfg,
        store,
        client,
        slack,
        task: { owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, checkoutDir: checkout.dir },
        piAgentDir: process.env.PI_CODING_AGENT_DIR ?? ".pi/agent",
        artifactDir: process.env.LAIDBACK_ARTIFACT_DIR ?? "data/reviews",
        log: (line) => console.log(`    ${line}`),
      });
      if (result.skipped) console.log(`    skipped: ${result.skipped}`);
      else if (result.posted) console.log(`    posted ${result.posted.state}: ${result.posted.html_url}`);
      else console.log(`    composed and stored, nothing posted (dry run ${result.dryRun}, gate ${result.gate?.state})`);
    } catch (error) {
      // A failed run leaves the state row absent, so the next cycle retries the same head.
      console.error(`    run failed: ${error.message}`);
    } finally {
      if (checkout) releaseWorktree({ ...checkout, cfg, log: (line) => console.log(`    ${line}`) });
    }
  }
}

async function main() {
  const cfg = loadConfig();
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

  // The design assumes the credential cannot write repository contents. Check before the first cycle,
  // not after a review posts something.
  const probeRepo = cfg.github.probeRepo || cfg.github.repos[0] || "";
  const probe = probeRepo
    ? await probeContentsReadOnly({ client, repo: probeRepo, log: (line) => console.log(`  ${line}`) })
    : { verdict: "skipped", detail: "github.probeRepo is unset and github.repos is empty" };
  if (probe.verdict === "can_write") {
    throw new Error(`refusing to start: the token can write repository contents (${probe.detail})`);
  }
  if (probe.verdict === "read_only") console.log(`token scope: ${probe.detail}`);
  if (probe.verdict === "unknown") console.log(`token scope unproven: ${probe.detail}`);
  if (probe.verdict === "skipped") console.log(`token scope not probed: ${probe.detail}`);

  let stopping = false;
  process.on("SIGINT", () => {
    console.log("stopping after the current cycle");
    stopping = true;
  });

  while (!stopping) {
    const started = Date.now();
    try {
      await cycle({ cfg, store, client, slack });
    } catch (error) {
      console.error(`cycle failed: ${error.message}`);
    }
    await sleep(Math.max(0, cfg.github.pollIntervalMs - (Date.now() - started)));
  }

  store.close();
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
