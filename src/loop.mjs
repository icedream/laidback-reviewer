/**
 * The poll loop: find pull requests assigned to me, review them, and stop short of anything the
 * policy or the gate has not allowed.
 *
 * One review at a time: the local inference server holds one prompt, so overlapping runs would fail
 * rather than queue. Separate from index.mjs so a cycle can be driven from a test.
 */

import { prepareCheckout, releaseWorktree, sweepScratch } from "./checkout.mjs";
import { findCandidates } from "./discovery.mjs";
import { taskGateDecision } from "./gate/gate.mjs";
import { clearFailure, failureNote, failurePlan, recordFailure } from "./proposal/retries.mjs";
import { postApprovedReview } from "./proposal/repost.mjs";
import { runReview } from "./review-run.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cycle({
  cfg,
  store,
  client,
  transport,
  shutdown = null,
  piAgentDir = process.env.PI_CODING_AGENT_DIR ?? ".pi/agent",
  artifactDir = process.env.LAIDBACK_ARTIFACT_DIR ?? "data/reviews",
  log = (line) => console.log(line),
  logErr = (line) => console.error(line),
}) {
  if (transport) {
    transport?.expire();
    const decided = await transport.readDecisions();
    for (const gate of decided) log(`gate ${gate.id} ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
  }

  // A deferral keeps its tree; a tree no deferral keeps is garbage, and garbage here is also misleading
  // because a later pass could read another run's comparison files as its own.
  sweepScratch({ cfg, keepRunIds: store.allDeferrals().map((row) => row.run_id), olderThanMs: cfg.checkout.keepScratchMs, log });

  // Reviews an admin approved between cycles go out now, re-anchored against the current head. One
  // failure must not cost the rest of the cycle: the row stays queued and is retried next time.
  for (const reviewId of store.approvedUnpostedReviews()) {
    try {
      await postApprovedReview({ cfg, store, client, reviewId, log });
    } catch (error) {
      log(`  repost ${reviewId.slice(0, 8)} failed: ${error.message}`);
    }
  }

  const { candidates, deferred, rejected, cursorIso } = await findCandidates({ cfg, client, store });
  log(
    `cycle: ${candidates.length} candidate(s) since ${cursorIso.slice(0, 16)}${rejected.length ? `, ${rejected.length} rejected` : ""}${deferred.length ? `, ${deferred.length} deferred to the next cycle` : ""}`,
  );
  for (const item of rejected) log(`  skip ${item.pr}: ${item.reason}`);

  const handleCandidate = async (candidate) => {
    const key = { owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, head_sha: candidate.headSha };
    const plan = failurePlan({ cfg, row: store.getFailure(key) });
    if (!plan.tryNow) {
      log(`  candidate ${candidate.htmlUrl}: skipped, ${plan.reason}`);
      return "waiting";
    }

    // A head set aside because the model was occupied is not a failure, so it is not counted against
    // the parking threshold; it just waits for the slot.
    const deferral = store.deferralFor(key);
    if (deferral && Date.parse(deferral.until_at) > Date.now()) {
      log(`  candidate ${candidate.htmlUrl}: deferred until ${deferral.until_at.slice(11, 16)} (${deferral.reason})`);
      return "deferred";
    }
    if (deferral) store.clearDeferral(key);

    // One gate answers one review request. While that gate stands, or once it has been answered, the cycle
    // leaves the head alone: only a newer request asks again, and that arrives as a different candidate.
    // A pass asked for at the gate is already answered by that tap, so it does not wait on a new task
    // gate, and the message it was asked on carries its progress.
    const taskGate = candidate.rerun
      ? { proceed: true, kind: "rerun", gateId: candidate.statusGateId ?? null }
      : taskGateDecision(
          store.latestGateFor({ owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, stage: "before_review" }),
          candidate.requestTs ?? "",
        );
    if (!taskGate.proceed && taskGate.kind !== "none" && taskGate.kind !== "re-requested") {
      log(`  candidate ${candidate.htmlUrl}: task gate ${taskGate.gateId} is ${taskGate.kind}; nothing runs`);
      return "gate";
    }

    log(`  candidate ${candidate.htmlUrl}: ${candidate.reason}${candidate.reRequest ? ` (re-requested ${candidate.reRequest.askedAt.slice(0, 16)}, earlier pass ${candidate.reRequest.handledAt.slice(0, 16)})` : ""}${plan.attempts ? ` (${plan.reason})` : ""}`);
    let checkout = null;
    let keepCheckout = false;
    try {
      checkout = prepareCheckout({
        cfg,
        owner: candidate.owner,
        repo: candidate.repo,
        pr: candidate.pr,
        headRef: candidate.headRef,
        headSha: candidate.headSha,
        // The pass that was interrupted left its tree where its transcript says it is. Same run id, same
        // paths, so the resumed model can keep reading the files it already looked at.
        runId: deferral?.run_id || undefined,
        log,
      });
      const result = await runReview({
        cfg,
        store,
        client,
        transport,
        shutdown,
        task: { owner: candidate.owner, repo: candidate.repo, pr: candidate.pr, checkoutDir: checkout.dir, compareDir: checkout.compareDir, runId: checkout.runId, reRequest: candidate.reRequest ?? null, requestTs: candidate.requestTs ?? null, rerun: candidate.rerun === true, skipTaskGate: candidate.rerun === true, resumeScratchKept: Boolean(deferral?.run_id && checkout.runId === deferral.run_id), resumeSessionFile: deferral?.session_file ?? candidate.resumeSessionFile ?? null, resumedAt: deferral?.until_at ?? candidate.resumedAt ?? "", resumeReason: deferral ? "interrupted" : candidate.rerun ? "rerun" : "", statusGateId: taskGate.gateId ?? null },
        piAgentDir,
        artifactDir,
        log,
      });
      clearFailure({ store, key });
      if (result.skipped) log(`    skipped: ${result.skipped}`);
      else if (result.posted) log(`    posted ${result.posted.state}: ${result.posted.html_url}`);
      else log(`    composed and stored, nothing posted (dry run ${result.dryRun}, gate ${result.gate?.state})`);
    } catch (error) {
      if (error?.name === "ModelBusyError" || error?.name === "ReviewInterruptedError") {
        // Nothing about the PR went wrong, so the head is put back for later instead of burning an
        // attempt: a shared inference slot must not park a review that was never run.
        // A restart leaves the head due at once, so the next start picks it straight back up.
        const delay = error?.name === "ReviewInterruptedError" ? 0 : cfg.agent.model.deferMs;
        const until = new Date(Date.now() + delay).toISOString();
        // A pass cancelled before it reached the prompt has nothing new to point at, and overwriting the
        // pointers would drop the transcript and tree that are worth resuming.
        store.deferHead({
          ...key,
          until_at: until,
          reason: error.message,
          sessionFile: error.sessionFile ?? deferral?.session_file ?? null,
          runId: error.runId ?? checkout?.runId ?? deferral?.run_id ?? null,
          checkoutDir: error.checkoutDir ?? checkout?.dir ?? deferral?.checkout_dir ?? null,
        });
        // The transcript names paths in this tree. Deleting it here is what turns a pause into a restart.
        keepCheckout = true;
        log(`    deferred: ${error.message}, retry after ${until.slice(11, 16)}${checkout ? `, tree kept at ${checkout.dir}` : ""}`);
        return "deferred";
      }
      // Recorded against this head so the next cycle waits rather than re-running a busy server
      // or a branch that does not build.
      const plan = recordFailure({ cfg, store, key, error, log });
      if (cfg.gate?.notifyFailures !== false && transport?.notify) {
        try {
          await transport.notify(failureNote({ cfg, candidate, error, plan }));
        } catch (notifyError) {
          log(`    the gate channel could not carry the failure: ${notifyError.message}`);
        }
      }
    } finally {
      if (checkout && !keepCheckout) releaseWorktree({ ...checkout, cfg, log });
    }
    return "done";
  };

  for (const candidate of candidates) await handleCandidate(candidate);

  // Another pass asked for on a gate. It does not wait for GitHub to mention the pull request again: the
  // request itself names the head, so the cycle fetches the pull request and runs the pass.
  for (const row of store.pendingReruns()) {
    const key = { owner: row.owner, repo: row.repo, pr: row.pr, head_sha: row.head_sha };
    let outcome = "failed";
    try {
      const seen = store.seenFor(key);
      if (seen && seen.rereviews >= cfg.reviews.maxReReviewsPerHead) {
        log(`  rerun ${row.owner}/${row.repo}#${row.pr}: ${seen.rereviews} passes over this head already, the ceiling is ${cfg.reviews.maxReReviewsPerHead}`);
        outcome = "parked";
      } else {
        const prJson = await client.getPull(row.owner, row.repo, row.pr);
        const headSha = prJson.head.sha;
        const key2 = { owner: row.owner, repo: row.repo, pr: row.pr, head_sha: headSha };
        // A pull request that gained commits since the request is not a reason to do nothing: the request
        // is for another pass over this pull request, and the only head worth passing over is the current
        // one. Repositories where CODEOWNERS holds the review pending cannot produce a new request event,
        // so dropping here means the new head is never reviewed at all.
        const headSeen = headSha === row.head_sha ? seen : store.seenFor(key2);
        if (headSeen && headSeen.rereviews >= cfg.reviews.maxReReviewsPerHead) {
          log(`  rerun ${row.owner}/${row.repo}#${row.pr}: ${headSeen.rereviews} passes over ${headSha.slice(0, 8)} already, the ceiling is ${cfg.reviews.maxReReviewsPerHead}`);
          outcome = "parked";
        } else {
          if (headSha !== row.head_sha) log(`  rerun ${row.owner}/${row.repo}#${row.pr}: the head moved to ${headSha.slice(0, 8)} since the request, that is what gets the new pass`);
          const prior = store.reviewFor(key2);
          const priorSession = store.latestSessionFor(key2) ?? (headSha === row.head_sha ? null : store.latestSessionFor(key));
          log(`  rerun ${prJson.html_url}: another pass requested by ${row.requested_by} at ${row.requested_at.slice(0, 16)}${priorSession ? `, continuing from the ${priorSession.created_at.slice(11, 16)} pass` : " from scratch"}`);
          outcome = await handleCandidate({
            owner: row.owner,
            repo: row.repo,
            pr: row.pr,
            headSha,
            headRef: prJson.head.ref,
            htmlUrl: prJson.html_url,
            reason: "another pass requested at the gate",
            reRequest: { askedAt: row.requested_at, handledAt: prior?.handledAt ?? row.requested_at },
            requestTs: row.requested_at,
            rerun: true,
            resumeSessionFile: priorSession?.session_file ?? null,
            resumedAt: priorSession?.created_at ?? row.requested_at,
            statusGateId: row.gate_id ?? null,
          });
        }
      }
    } catch (error) {
      log(`  rerun ${row.owner}/${row.repo}#${row.pr} failed: ${error.message}`);
    }
    // A head set aside for a busy inference server keeps its request: the pass has not run yet.
    if (outcome !== "deferred") store.consumeRerun(key);
  }
}

export async function runLoop({
  cfg,
  store,
  client,
  transport,
  stop = { current: false },
  runCycle = cycle,
  shutdown = null,
  now = () => Date.now(),
  nap = sleep,
  gateTimer = intervalTimer,
}) {
  // A gate posted by an earlier build keeps the message it was given, so the controls a newer build
  // offers are put on the messages that are still waiting.
  if (transport?.refreshControls) {
    try {
      const refreshed = await transport.refreshControls();
      if (refreshed) console.log(`controls refreshed on ${refreshed} waiting gate message(s)`);
    } catch (error) {
      console.error(`gate controls could not be refreshed: ${error.message}`);
    }
  }

  let wake = false; // a decision landed, so the next discovery cycle starts without waiting for the clock
  let posting = null; // one poster at a time, whatever asked for it

  async function postApproved() {
    if (!store || !client) return;
    if (posting) return posting;
    posting = (async () => {
      for (const reviewId of store.approvedUnpostedReviews()) {
        try {
          await postApprovedReview({ cfg, store, client, reviewId, log: console.log });
        } catch (error) {
          console.error(`  posting review ${reviewId} failed: ${error.message}`);
        }
      }
    })().finally(() => {
      posting = null;
    });
    return posting;
  }

  async function readGate() {
    if (!transport) return 0;
    let decided = [];
    try {
      decided = await transport.readDecisions();
    } catch (error) {
      console.error(`reading the gate failed: ${error.message}`);
      return 0;
    }
    if (!decided.length) return 0;
    for (const gate of decided) console.log(`gate ${gate.id} ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
    wake = true;
    // An approval does not wait for the pass in flight: the review is posted as soon as the tap is read.
    await postApproved();
    return decided.length;
  }

  // One channel request at a time for the whole process. A channel that holds a request open, as Telegram
  // long-polling does, treats a second one as another bot instance and terminates the first, which is what
  // a cycle reading the gate on its own used to cause at every discovery boundary.
  let inFlightRead = null;

  function takeGateRead() {
    // Join the read that is already open rather than issuing a second one: a second request on the same
    // token is what the channel reports as another bot instance.
    inFlightRead ??= readGate().finally(() => {
      inFlightRead = null;
    });
    return inFlightRead;
  }

  /** An opportunistic read: if the poller already holds the slot, this one does nothing rather than wait. */
  function opportunisticGateRead() {
    return inFlightRead ? Promise.resolve([]) : takeGateRead();
  }

  // A cycle reads the gate through this transport, so its read joins the poller's instead of racing it.
  const gateForCycle = transport ? { ...transport, readDecisions: async () => (inFlightRead ? [] : (await takeGateRead(), [])) } : null;

  while (!stop.current) {
    const started = now();
    wake = false;

    // The gate is read while a cycle runs, not only after it. A review takes minutes, and a tap pressed in
    // that window used to sit unread until the pass finished.
    let stopPoller;
    if (transport?.longPollMs) {
      // The transport holds its request open until something arrives, so the poller is a loop rather than
      // a clock: a tap lands as soon as the channel releases the connection. One request at a time, which
      // is also what the channel requires of a token.
      let running = true;
      const polling = (async () => {
        while (running && !stop.current) {
          await takeGateRead();
        }
      })();
      stopPoller = async () => {
        running = false;
        await polling;
      };
    } else {
      stopPoller = gateTimer(cfg.gate.pollIntervalMs, () => {
        if (!inFlightRead) void takeGateRead();
      });
    }
    try {
      await runCycle({ cfg, store, client, transport: gateForCycle, shutdown });
    } catch (error) {
      console.error(`cycle failed: ${error.message}`);
    } finally {
      await stopPoller();
      if (inFlightRead) await inFlightRead;
    }

    // Between discovery cycles the loop waits on the gate rather than on the clock: a tap lands within
    // gate.pollIntervalMs, or immediately for a channel that long-polls, and the cycle that acts on it runs
    // right away instead of up to a full github.pollIntervalMs later.
    const until = started + cfg.github.pollIntervalMs;
    while (!stop.current && !wake && now() - started < cfg.github.pollIntervalMs) {
      if (!transport?.longPollMs) await nap(Math.min(cfg.gate.pollIntervalMs, Math.max(0, until - now())));
      await opportunisticGateRead();
    }
  }

  transport?.releaseLease?.();
}

function intervalTimer(ms, fn) {
  const timer = setInterval(fn, ms);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
