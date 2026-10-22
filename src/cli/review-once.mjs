#!/usr/bin/env node
/**
 * Review one PR from the command line.
 *
 *   node src/cli/review-once.mjs --repo example/orders-svc --pr 143 --dir /path/to/checkout
 *
 * Posting follows `reviews.dryRun` in the config. `--post` forces it on, `--dry-run` forces it off, and
 * either way the gate still decides whether anything reaches GitHub.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, secret } from "../config.mjs";
import { createGithubClient } from "../github/client.mjs";
import { matchRepository } from "../github/scope.mjs";
import { slackGateFromConfig } from "../gate/slack.mjs";
import { openStore } from "../proposal/store.mjs";
import { runReview } from "../review-run.mjs";
import { prepareCheckout, releaseWorktree } from "../checkout.mjs";

function parseArgs(argv) {
  const out = { post: false, dryRun: false, debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--post") out.post = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--debug") out.debug = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (!out.positional) out.positional = arg;
  }
  return out;
}

/** Progress output and the harness's own decisions; a flag or the environment both work. */
function applyDebug(cfg, args) {
  if (!args.debug && !process.env.LAIDBACK_DEBUG) return cfg;
  cfg.logging.level = "debug";
  cfg.logging.progress = "full";
  return cfg;
}

/**
 * `--dry-run` has to override a config that permits posting, otherwise the flag that promises nothing
 * reaches GitHub still queues a gate that posts once it is approved.
 */
export function resolveDryRun(cfg, args) {
  if (args.post) cfg.reviews.dryRun = false;
  if (args.dryRun) cfg.reviews.dryRun = true;
  return cfg.reviews.dryRun;
}

export { applyDebug, parseArgs };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ path: args.config ?? process.env.LAIDBACK_CONFIG ?? "config.yaml" });
  resolveDryRun(cfg, args);
  applyDebug(cfg, args);

  const [owner, repo] = String(args.repo ?? "").split("/");
  const pr = Number(args.pr);
  if (!owner || !repo || !pr) {
    console.error("usage: node src/cli/review-once.mjs --repo <owner>/<name> --pr <number> [--dir <checkout>] [--post | --dry-run] [--debug]");
    process.exit(2);
  }

  const requestedDir = args.dir ? path.resolve(args.dir) : "";
  const scope = matchRepository(`${owner}/${repo}`, cfg.github);
  if (!scope.allowed) {
    console.log(`note: ${owner}/${repo} is outside the configured scope (${scope.reason}); a run you asked for by number proceeds anyway`);
  }
  const store = openStore(args.state ?? process.env.LAIDBACK_STATE_DB ?? "data/state.db");
  const client = createGithubClient({
    baseUrl: process.env.LAIDBACK_GH_API || "https://api.github.com",
    token: secret(cfg, cfg.github.tokenEnv, { required: true }),
    timeoutMs: cfg.github.timeoutMs,
  });

  // `--dir` is used as given. Without it the run builds the same cached clone and detached worktree the
  // poll loop uses; pointing the session at a path that does not exist yet leaves the agent with the PR
  // body, no tree, no gates and no grep.
  let checkout = null;
  if (!requestedDir) {
    const pull = await client.getPull(owner, repo, pr);
    checkout = prepareCheckout({ cfg, owner, repo, pr, headRef: pull.head?.ref, headSha: pull.head?.sha, log: console.error });
  }

  let result = null;
  let busy = null;
  try {
    result = await runReview({
      cfg,
      store,
      client,
      slack: slackGateFromConfig({ cfg, store, log: (line) => console.error(line) }),
      task: { owner, repo, pr, checkoutDir: requestedDir || checkout.dir, compareDir: checkout?.compareDir, runId: checkout?.runId },
      piAgentDir: process.env.PI_CODING_AGENT_DIR ?? ".pi/agent",
      artifactDir: args.artifacts ?? process.env.LAIDBACK_ARTIFACT_DIR ?? "data/reviews",
    });
  } catch (error) {
    if (error?.name !== "ModelBusyError") throw error;
    busy = error;
  } finally {
    store.close();
    if (checkout) releaseWorktree({ ...checkout, cfg, log: console.error });
  }

  if (busy) {
    console.log(`model server busy: ${busy.message}. Nothing was sent, and the request was not left queued.`);
    process.exitCode = 3;
    return;
  }

  console.log(
    JSON.stringify(
      {
        pr: result.pr?.html_url,
        head: result.headSha?.slice(0, 8),
        skipped: result.skipped ?? null,
        verdict: result.composed?.verdict,
        action: result.composed?.action,
        event: result.composed?.event,
        comments: result.composed?.payload.comments.length ?? 0,
        dryRun: result.dryRun,
        gate: result.gate?.state ?? null,
        posted: result.posted ?? null,
        artifact: result.artifactPath,
      },
      null,
      2,
    ),
  );
}

// Imported by tests for the flag handling; only a direct run performs a review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
