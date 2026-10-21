/**
 * The poll loop: find pull requests assigned to me, review them, and stop short of anything the
 * policy or the gate has not allowed.
 *
 * One review at a time: the local inference server holds one prompt, so overlapping runs would fail
 * rather than queue. Separate from index.mjs so a cycle can be driven from a test.
 */

import { prepareCheckout, releaseWorktree } from "./checkout.mjs";
import { findCandidates } from "./discovery.mjs";
import { clearFailure, failurePlan, recordFailure } from "./proposal/retries.mjs";
import { postApprovedReview } from "./proposal/repost.mjs";
import { runReview } from "./review-run.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cycle({
  cfg,
  store,
  client,
  slack,
  piAgentDir = process.env.PI_CODING_AGENT_DIR ?? ".pi/agent",
  artifactDir = process.env.LAIDBACK_ARTIFACT_DIR ?? "data/reviews",
  log = (line) => console.log(line),
  logErr = (line) => console.error(line),
}) {
  if (slack) {
    slack.expire();
    const decided = await slack.readDecisions();
    for (const gate of decided) log(`gate ${gate.id} ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
  }

  // Reviews an admin approved between cycles go out now, re-anchored against the current head.
  for (const reviewId of store.approvedUnpostedReviews()) {
    await postApprovedReview({ cfg, store, client, reviewId, log });
  }

  const { candidates, deferred, rejected, cursorIso } = await findCandidates({ cfg, client, store });
  log(
    `cycle: ${candidates.length} candidate(s) since ${cursorIso.slice(0, 16)}${rejected.length ? `, ${rejected.length} rejected` : ""}${deferred.length ? `, ${deferred.length} deferred to the next cycle` : ""}`,
  );
  for (const item of rejected) log(`  skip ${item.pr}: ${item.reason}`);

  for (const candidate of candidates) {
    const key = { owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, head_sha: candidate.headSha };
    const plan = failurePlan({ cfg, row: store.getFailure(key) });
    if (!plan.tryNow) {
      log(`  candidate ${candidate.htmlUrl}: skipped, ${plan.reason}`);
      continue;
    }

    log(`  candidate ${candidate.htmlUrl}: ${candidate.reason}${plan.attempts ? ` (${plan.reason})` : ""}`);
    let checkout = null;
    try {
      checkout = prepareCheckout({
        cfg,
        owner: candidate.owner,
        repo: candidate.repo,
        pr: candidate.pr,
        headRef: candidate.headRef,
        headSha: candidate.headSha,
        log,
      });
      const result = await runReview({
        cfg,
        store,
        client,
        slack,
        task: { owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, checkoutDir: checkout.dir },
        piAgentDir,
        artifactDir,
        log,
      });
      clearFailure({ store, key });
      if (result.skipped) log(`    skipped: ${result.skipped}`);
      else if (result.posted) log(`    posted ${result.posted.state}: ${result.posted.html_url}`);
      else log(`    composed and stored, nothing posted (dry run ${result.dryRun}, gate ${result.gate?.state})`);
    } catch (error) {
      // Recorded against this head so the next cycle waits rather than re-running a busy server
      // or a branch that does not build.
      recordFailure({ cfg, store, key, error, log });
    } finally {
      if (checkout) releaseWorktree({ ...checkout, cfg, log });
    }
  }
}

export async function runLoop({ cfg, store, client, slack, stop = { current: false } }) {
  while (!stop.current) {
    const started = Date.now();
    try {
      await cycle({ cfg, store, client, slack });
    } catch (error) {
      console.error(`cycle failed: ${error.message}`);
    }
    await sleep(Math.max(0, cfg.github.pollIntervalMs - (Date.now() - started)));
  }
}
