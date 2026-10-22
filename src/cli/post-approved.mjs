#!/usr/bin/env node
/**
 * Send a review an admin already approved.
 *
 *   node src/cli/post-approved.mjs <review-id>
 *
 * Normally the poll loop does this on its own cycle. The command exists for the case where you want
 * to control the moment it goes out.
 */

import { loadConfig, secret } from "../config.mjs";
import { createGithubClient } from "../github/client.mjs";
import { openStore } from "../proposal/store.mjs";
import { postApprovedReview } from "../proposal/repost.mjs";

async function main() {
  const reviewId = process.argv[2];
  if (!reviewId) {
    console.error("usage: node src/cli/post-approved.mjs <review-id>   (ids: node src/cli/gate.mjs list)");
    process.exit(2);
  }

  const cfg = loadConfig();
  const store = openStore(process.env.LAIDBACK_STATE_DB ?? "data/state.db");
  const client = createGithubClient({
    baseUrl: process.env.LAIDBACK_GH_API || "https://api.github.com",
    token: secret(cfg, cfg.github.tokenEnv, { required: true }),
    timeoutMs: cfg.github.timeoutMs,
  });

  const result = await postApprovedReview({ cfg, store, client, reviewId, log: console.error });
  if (result.skipped) {
    console.error(`not posted: ${result.skipped}${result.gates ? ` (${result.gates.join(", ")})` : ""}${result.html_url ? ` ${result.html_url}` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${result.posted.state} on PR with ${result.composed.payload.comments.length} comment(s): ${result.posted.html_url}`);
  store.close();
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
