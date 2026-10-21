#!/usr/bin/env node
/**
 * Review one PR from the command line.
 *
 *   node src/cli/review-once.mjs --repo example/orders-svc --pr 143 --dir /path/to/checkout
 *
 * Dry run unless --post is given, and --post still honours the gate: it changes what the policy may
 * send, never whether a human is asked first.
 */

import path from "node:path";
import { loadConfig, secret } from "../config.mjs";
import { createGithubClient } from "../github/client.mjs";
import { openStore } from "../proposal/store.mjs";
import { runReview } from "../review-run.mjs";

function parseArgs(argv) {
  const out = { post: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--post") out.post = true;
    else if (arg === "--dry-run") out.post = false;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (!out.positional) out.positional = arg;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ path: args.config ?? process.env.LAIDBACK_CONFIG ?? "config.yaml" });
  if (args.post) cfg.reviews.dryRun = false;

  const [owner, repo] = String(args.repo ?? "").split("/");
  const pr = Number(args.pr);
  if (!owner || !repo || !pr) {
    console.error("usage: node src/cli/review-once.mjs --repo <owner>/<name> --pr <number> [--dir <checkout>] [--post]");
    process.exit(2);
  }

  const checkoutDir = path.resolve(args.dir ?? path.join(cfg.checkout.root, owner, repo));
  const store = openStore(args.state ?? process.env.LAIDBACK_STATE_DB ?? "data/state.db");
  const client = createGithubClient({
    baseUrl: process.env.LAIDBACK_GH_API || "https://api.github.com",
    token: secret(cfg, cfg.github.tokenEnv, { required: true }),
  });

  const result = await runReview({
    cfg,
    store,
    client,
    task: { owner, repo, pr, checkoutDir },
    piAgentDir: process.env.PI_CODING_AGENT_DIR ?? ".pi/agent",
    artifactDir: args.artifacts ?? "data/reviews",
  });

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
  store.close();
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
