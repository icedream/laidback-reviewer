/**
 * One review run.
 *
 * Fetch → agent session → proposal → policy → gate → post. The agent never reaches GitHub: it records
 * a proposal, and only the last step can write, and only if the policy and the gate allow it.
 */

import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadAgentDef, nonInteractiveContract } from "./agent/agent-def.mjs";
import { createReviewGuard } from "./agent/guard.mjs";
import { createProgress } from "./agent/progress.mjs";
import { createRunStatus } from "./agent/run-status.mjs";
import { waitForMcpTools } from "./agent/mcp-settle.mjs";
import { promptWithModelRetry } from "./agent/model-retry.mjs";
import { modelServerStatus, resolveModelServer, slotOccupancy } from "./agent/model-server.mjs";
import { ModelBusyError } from "./agent/run-watch.mjs";
import { buildTaskPrompt } from "./agent/prompt.mjs";
import { rephraseBanner } from "./agent/rephrase.mjs";
import { REVIEW_TOOLS, createReviewSession } from "./agent/runtime.mjs";
import { createProposalCollector, createReviewTools } from "./agent/tools.mjs";
import { comparisonDir, configureGitAuth, configureGoModules, newRunId } from "./checkout.mjs";
import { resolveLintTool } from "./tools/golangci-lint.mjs";
import { stageReusableWorkflows } from "./tools/reusable-workflows.mjs";
import { pickContext } from "./context/carried-over.mjs";
import { resolveStack } from "./context/stack.mjs";
import { HeadMovedError, submitReview } from "./github/poster.mjs";
import { createGate, renderGateSummary } from "./gate/gate.mjs";
import { writeArtifact } from "./proposal/artifact.mjs";
import { composeReview, planBanner } from "./proposal/policy.mjs";

/** The task gate names the pull request and links it, so the message says which review it belongs to. */
export function taskGateSummary({ pr, headSha }) {
  return [
    `PR: ${pr.html_url}`,
    `Review requested for ${pr.repository}#${pr.number} at ${String(headSha).slice(0, 8)}: ${pr.title}`,
  ].join("\n");
}

export function toPrView(json, { owner, repo }) {
  return {
    number: json.number,
    owner,
    repo,
    repository: `${owner}/${repo}`,
    title: json.title,
    body: json.body ?? "",
    draft: !!json.draft,
    html_url: json.html_url,
    base: { ref: json.base?.ref, sha: json.base?.sha },
    head: { ref: json.head?.ref, sha: json.head?.sha },
    assignees: (json.assignees ?? []).map((assignee) => assignee.login),
    // Kept apart because they mean different things: a user asked me, or a group I belong to was asked.
    requested_reviewers: (json.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    requested_teams: (json.requested_teams ?? []).map((team) => team.slug ?? team.name),
    author: json.user?.login,
    raw: json,
  };
}

export async function runReview({ cfg, store, client, task, piAgentDir, artifactDir, transport = null, log = console.error }) {
  const { owner, repo, pr: prNumber, checkoutDir } = task;
  let approvedTaskGate = null;

  // The message a task gate was approved on becomes the progress display for that run, so an approved
  // gate does not sit unchanged for ten minutes looking like nothing happened.
  const runStatus =
    task.statusGateId && typeof transport?.status === "function"
      ? createRunStatus({
          send: (text) => transport.status(task.statusGateId, text),
          title: `Reviewing ${owner}/${repo}#${prNumber}`,
          // The canonical url is known before the fetch; the fetched one replaces it if GitHub disagrees.
          prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          everyMs: cfg.logging.statusEveryMs,
          budgetMs: cfg.reviews.budgetMs,
          log,
        })
      : null;
  await runStatus?.setStage("reading the pull request");
  const prJson = await client.getPull(owner, repo, prNumber);
  const pr = toPrView(prJson, { owner, repo });
  const headSha = pr.head.sha;
  runStatus?.setUrl(pr.html_url);
  runStatus?.note(`head ${headSha.slice(0, 8)} on ${pr.head.ref ?? "?"}`);

  if (pr.draft && cfg.trigger.skipDraft) {
    return { skipped: "draft", pr };
  }

  const files = await client.listFiles(owner, repo, prNumber);
  const gate = createGate({ cfg, store, log, transport });
  const target = { owner, repo, pr: prNumber, head_sha: headSha };
  if (task.skipTaskGate) {
    log("task gate not opened: another pass was asked for on a gate, which is the approval");
  } else if (gate.requiresApproval("before_review")) {
    // The gate answers one review request, identified by that event's timestamp: approving it releases this
    // head once, and only a later request asks again.
    const taskGate = gate.priorDecision({ stage: "before_review", target, askedAt: task.requestTs ?? "" });
    if (!taskGate.proceed) {
      if (taskGate.kind === "none" || taskGate.kind === "re-requested") {
        const preGate = await gate.open({
          stage: "before_review",
          reviewId: null,
          target,
          requestTs: task.requestTs ?? null,
          summary: taskGateSummary({ pr, headSha }),
        });
        return { skipped: "gate_queued", gate: preGate, pr };
      }
      log(`task gate ${taskGate.gateId} is ${taskGate.kind} for this head; the review does not run`);
      return { skipped: `gate_${taskGate.kind}`, gate: taskGate, pr };
    }
    log(`task gate ${taskGate.gateId} answers this request: running the review`);
    approvedTaskGate = taskGate.gateId;
  }

  const [reviews, comments, discussion] = await Promise.all([
    client.listReviews(owner, repo, prNumber),
    client.listInlineComments(owner, repo, prNumber),
    client.listDiscussionComments(owner, repo, prNumber),
  ]);
  // What the pass starts knowing is the first thing to look at when a re-review appears to be exploring
  // the repository from the beginning.
  log(`already on the PR: ${reviews.length} review(s), ${comments.length} inline comment(s), ${discussion.length} discussion comment(s)`);

  // A head is reviewed once. What reopens it is a fresh review request, carried in by discovery, or a
  // direct invocation, which is the operator asking for another pass by hand.
  if (store.alreadyHandled({ owner, repo, pr: prNumber, head_sha: headSha }) && !task.reRequest && !task.manual) {
    return { skipped: "already_reviewed", pr };
  }

  const agentDef = loadAgentDef(cfg.agent.agentDir, cfg.agent.name);

  // Comparison fetches (trunk, tags, a dependency's own repository) run under the comparison root
  // with the same read-only credential, so a version claim is read from source rather than inferred.
  // One run, one scratch area. A later session may carry this run's history, and it must not be able to
  // read another run's fetched comparisons as though they were still its own.
  await runStatus?.setStage("checking out the branch and its diff");
  const runId = task.runId ?? newRunId();
  const compareDir = task.compareDir ?? comparisonDir(cfg, owner, repo, prNumber, headSha, runId);
  fs.mkdirSync(compareDir, { recursive: true });
  if (cfg.checkout.mode === "clone") {
    configureGitAuth({ cfg, dir: checkoutDir, log });
    configureGoModules({ cfg, dir: checkoutDir, log });
  }

  const collector = createProposalCollector();
  // One list for both halves: the guard allows these paths and the prompt names them, so the agent is
  // not discovering the write boundary by hitting it. The toolchain install dir is included because a
  // repository that pins a version the image does not carry has to be able to fetch it itself.
  const writableRoots = [cfg.checkout.scratch, cfg.toolchain.installDir, compareDir, "/tmp"];
  const guard = createReviewGuard({
    allowHosts: cfg.tools.allowHosts,
    bashEnabled: cfg.tools.bash,
    writableRoots,
    checkoutDir,
  });

  const contract = nonInteractiveContract({ cfg, checkoutDir, prRef: pr.repository });

  // The linter is resolved before the session starts so the prompt can say which binary to use. A
  // repository pinned to a major the image does not carry otherwise reads as a broken branch.
  const lint = await resolveLintTool({ cfg, dir: checkoutDir, log });
  if (lint.reusable?.length) lint.reusableStaged = await stageReusableWorkflows({ client, reusable: lint.reusable, compareDir, log });

  // Context is resolved before the session is built, because the choice decides which session file
  // the agent starts from. The stack walk answers "which PR is this stacked on", which is the one
  // place the shared code was read first.
  const repoInfo = await client.getRepo(owner, repo);
  const stack = await resolveStack({ client, owner, repo, pr, defaultBranch: repoInfo.default_branch, log });
  const context = pickContext({ cfg, store, pr, stack, files });
  log(context.matched ? `context: ${context.mode} from #${context.review.pr} (${context.kind})` : `context: none (${context.reason})`);

  // Whether this is a second look, and how we know. The GitHub request event is the authority; the reviews
  // table covers the case where discovery's poll cursor no longer says anything.
  const earlierRow = store.reviewFor({ owner, repo, pr: prNumber, head_sha: headSha });
  const earlierPass =
    task.reRequest ?? (earlierRow ? { handledAt: earlierRow.created_at } : null);
  if (earlierPass) {
    log(
      task.reRequest
        ? `re-review of this head: GitHub asked again at ${task.reRequest.askedAt}, after a pass at ${task.reRequest.handledAt}`
        : `re-review of this head: an earlier pass at ${earlierPass.handledAt} is recorded here, no newer request event`,
    );
  }

  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir,
    headSha,
    prior: { reviews, comments, discussion },
    reRequest: earlierPass,
    compareDir,
    writableRoots,
    allowHosts: cfg.tools.allowHosts,
    lint: lint.mode === "off" ? null : lint,
    resume: task.resumeSessionFile ? { at: task.resumedAt ?? "", sessionFile: task.resumeSessionFile, reason: task.resumeReason ?? "interrupted" } : null,
    context: context.matched ? { description: context.description, instructions: context.instructions } : null,
  });

  // The model slot is shared with the interactive session, and a request queued behind another still
  // occupies it. The queue is read before anything is sent, and again by the run watchdog.
  const modelServer = resolveModelServer({ piAgentDir, provider: cfg.agent.model.provider, modelId: cfg.agent.model.id, statusUrl: cfg.agent.model.statusUrl });
  const modelProbe = () =>
    modelServerStatus({
      server: modelServer,
      mode: cfg.agent.model.probe,
      probeTimeoutMs: cfg.agent.model.probeTimeoutMs,
      latencyMs: cfg.agent.model.latencyMs,
    });
  const queue = await modelProbe();
  if (queue.busy) {
    log(`model server busy (${queue.phase || queue.source}): ${pr.repository}#${pr.number} is not worth sending yet`);
    throw new ModelBusyError(queue);
  }
  if (cfg.logging.level === "debug") log(`debug: model queue free (${queue.source}${queue.phase ? `, ${queue.phase}` : ""})`);
  // Whether this pass finds a warm cache or re-prefills from zero is a server fact, and it is the one
  // number that says whether saving a slot between deferrals would pay for itself.
  const occupancy = await slotOccupancy(modelServer).catch(() => null);
  if (occupancy?.promptTokens != null) log(`inference slot holds ${occupancy.promptTokens} prompt tokens (${occupancy.slotCount} slot(s), ${occupancy.processing} busy) before this pass`);

  // A head deferred because the inference slot was taken comes back to the session where it had already
  // read the diff. Forking that transcript is what keeps a deferral from restarting the review.
  if (!cfg.context.sessionDir) {
    log("sessions are in memory (context.sessionDir is empty): an interrupted pass cannot be resumed");
  }
  const sessionManager = task.resumeSessionFile && cfg.context.sessionDir
    ? SessionManager.forkFrom(task.resumeSessionFile, checkoutDir, cfg.context.sessionDir)
    : context.matched && context.mode === "fork" && cfg.context.sessionDir
      ? SessionManager.forkFrom(context.review.session_file, checkoutDir, cfg.context.sessionDir)
      : cfg.context.sessionDir
        ? SessionManager.create(checkoutDir, cfg.context.sessionDir)
        : SessionManager.inMemory(checkoutDir);

  if (task.resumeSessionFile && task.resumeReason === "rerun") {
    log(`forking the pass that is being replaced, from ${task.resumeSessionFile}`);
  }
  if (task.resumeSessionFile && task.resumeReason !== "rerun") {
    log(`resuming the interrupted pass from ${task.resumeSessionFile}${task.resumeScratchKept ? ", its scratch tree still in place" : ", its scratch tree gone"}`);
  }
  await runStatus?.setStage("starting the review session");
  const { session } = await createReviewSession({
    cfg,
    agentDir: piAgentDir,
    cwd: checkoutDir,
    agentDef,
    contract,
    extensionFactories: [guard.extension],
    customTools: createReviewTools({ collector, limits: { maxComments: cfg.reviews.maxComments } }),
    sessionManager,
    tools: REVIEW_TOOLS(cfg),
  });

  let progress = null;
  let stopProgress = null;
  let settle = { waitedMs: 0, ready: [], missing: [] };
  let busyRetriesUsed = 0;
  try {
    progress = createProgress({
      log,
      mode: cfg.logging.progress,
      heartbeatMs: cfg.logging.heartbeatMs,
      onState: (state) => runStatus?.progress(state),
    });
    stopProgress = session.subscribe(progress.handle);

    // The MCP extension connects after the session exists. Prompting at that moment asks the model to
    // open a ticket it has no tool for, and the review would still post without that coverage.
    settle = await waitForMcpTools({ session, servers: cfg.tools.mcp, timeoutMs: cfg.agent.mcpSettleMs });
    if (settle.ready.length) log(`mcp tools ready: ${settle.ready.join(", ")} after ${settle.waitedMs}ms`);
    if (settle.missing.length) log(`no mcp tools for: ${settle.missing.join(", ")} (waited ${settle.waitedMs}ms)`);

    log(`review ${pr.repository}#${pr.number} at ${headSha.slice(0, 8)}: agent ${agentDef.name}, ${files.length} changed files`);
    if (cfg.logging.level === "debug") {
      log(`debug: checkout ${checkoutDir}, comparison ${compareDir}, linter ${lint.mode}${lint.requestedVersion ? ` ${lint.requestedVersion}` : " (image)"}`);
    }
    try {
      busyRetriesUsed = await promptWithModelRetry({ session, cfg, collector, prompt, log, probe: modelProbe });
    } catch (error) {
      if (error?.name !== "ModelBusyError") {
        await runStatus?.finish("failed", error?.message ?? String(error));
      }
      if (error?.name === "ModelBusyError") {
        // The loop defers the head, and the next pass resumes from this transcript only if the run hands
        // it over before unwinding.
        error.sessionFile = session.sessionManager?.getSessionFile?.() ?? null;
        error.runId = task.runId ?? null;
        error.checkoutDir = checkoutDir;
        await runStatus?.finish("paused", "the inference server is busy; the head is deferred and will resume this session");
      }
      throw error;
    }
  } finally {
    // A cancelled or failed turn must leave nothing armed: a heartbeat that outlives the run keeps the
    // process alive and prints "still working" forever.
    progress?.stop();
    stopProgress?.();
    session.dispose();
  }

  const notes = [];
  if (settle.missing.length) notes.push(`no MCP tools for ${settle.missing.join(", ")}: the server did not connect within ${cfg.agent.mcpSettleMs}ms, so the ticket was not read`);
  if (lint.note) notes.push(`lint tooling: ${lint.note}`);
  if (lint.conflict) notes.push(`linter pins disagree: ${lint.pins.map((pin) => `${pin.version} (${pin.source})`).join(", ")}`);
  if (busyRetriesUsed) notes.push(`model endpoint failed ${busyRetriesUsed} time(s); the session was asked to continue`);
  if (!collector.submitted) notes.push("the run ended without review_submit; composing from what was recorded");
  for (const entry of guard.log) {
    // The command is kept so a denied call can be reviewed: a false positive in the deny list would
    // otherwise look like the model misbehaving.
    const detail = `${entry.tool}: ${entry.reason}${entry.command ? ` (${String(entry.command).replace(/\s+/g, " ").slice(0, 300)})` : ""}`;
    notes.push(`blocked ${detail}`);
    log(`blocked ${detail}`);
  }

  const proposal = collector.asProposal();
  if (!proposal.verdict) {
    // A model that left findings but no verdict still gets a review sent, as a comment.
    proposal.verdict = proposal.comments.length || proposal.body ? "comment" : null;
    if (proposal.verdict) notes.push("no verdict recorded by the model: treated as comment");
  }
  if (!proposal.verdict) throw new Error(`review run produced nothing for ${pr.repository}#${pr.number}`);

  // Authored banner: the review was told to carry the notice, so only a slot it left out is supplied here,
  // and a supplied slot is reworded only when its own flag asks for it.
  const bannerPlan = planBanner({ cfg, proposal });
  const toRephrase = Object.fromEntries(
    bannerPlan.supplied
      .filter((slot) => (slot === "prefix" ? cfg.banner.rephrasePrefix : cfg.banner.rephraseSuffix))
      .map((slot) => [slot, bannerPlan[slot]]),
  );
  let banner = bannerPlan;
  if (Object.keys(toRephrase).length) {
    try {
      const rephrased = await rephraseBanner({ cfg, agentDir: piAgentDir, cwd: checkoutDir, prRef: `${pr.repository}#${pr.number}`, slots: toRephrase, log });
      banner = { ...bannerPlan, ...rephrased };
    } catch (error) {
      // A failed rewrite is a wording problem, not a reason to lose the review.
      notes.push(`banner rephrase failed: ${error.message}; using the configured text`);
    }
  }

  const composed = composeReview({ proposal, cfg, files, headSha, owner, repo, banner });
  if (cfg.logging.level === "debug") log(`debug: policy ${composed.verdict} -> ${composed.action} (${composed.event}), ${composed.payload.comments.length} comment(s), ${composed.payload.body.length} chars of body`);
  const reviewId = store.saveReview({ owner, repo, pr: prNumber, head_sha: headSha, composed, dryRun: cfg.reviews.dryRun, notes });
  const artifactPath = writeArtifact({
    dir: artifactDir,
    pr,
    headSha,
    collector,
    composed,
    notes,
    decisions: composed.decisions,
    gate: null,
    posted: null,
  });
  store.setArtifact({ id: reviewId, path: artifactPath });
  store.setSession({
    id: reviewId,
    sessionFile: session.sessionManager?.getSessionFile() ?? null,
    branch: pr.head.ref,
    checkoutDir,
    stackKey: stack.key,
  });
  store.markSeen({ owner, repo, pr: prNumber, head_sha: headSha, reReview: Boolean(task.reRequest) });
  if (approvedTaskGate) store.consumeGate(approvedTaskGate);

  const gateState = await gate.open({
    stage: "before_post",
    reviewId,
    target: { owner, repo, pr: prNumber, head_sha: headSha },
    summary: renderGateSummary({ pr, headSha, composed, notes, decisions: composed.decisions }),
  });

  await runStatus?.finish(
    "review composed",
    `${composed.verdict}, ${composed.payload.comments.length} inline comment(s)` +
      (gateState.gateId ? `; post gate ${gateState.gateId} ${gateState.state === "approved" ? "cleared" : "awaits your approval"}` : "; nothing to approve"),
  );

  // The artifact is written twice on purpose: once before anything can fail, then again with the
  // posting outcome, so the record never claims a review was sent when the gate held it.
  const finish = (extra) => {
    const outcome = { pr, headSha, composed, reviewId, artifactPath, dryRun: cfg.reviews.dryRun, gate: gateState, blocked: guard.log, ...extra };
    writeArtifact({
      dir: artifactDir,
      pr,
      headSha,
      collector,
      composed,
      notes,
      decisions: composed.decisions,
      gate: gateState,
      posted: outcome.posted ?? null,
    });
    return outcome;
  };

  if (cfg.reviews.dryRun) {
    log(`dry run: nothing sent. ${artifactPath}`);
    return finish({ posted: null });
  }
  if (gateState.state !== "approved") {
    log(`review queued at gate ${gateState.gateId}; nothing sent`);
    return finish({ posted: null });
  }

  const posted = await postComposed({ client, owner, repo, prNumber, headSha, proposal, cfg, composed, log });
  store.markPosted({ id: reviewId, github_review_id: posted.id, html_url: posted.html_url });

  return finish({ posted });
}

/** Post, and if the head moved under the run, re-anchor the same proposal against the new head. */
async function postComposed({ client, owner, repo, prNumber, headSha, proposal, cfg, composed, log }) {
  try {
    return await submitReview({ client, owner, repo, pr: prNumber, payload: composed.payload, expectedHeadSha: headSha });
  } catch (error) {
    if (!(error instanceof HeadMovedError)) throw error;
    log(`${error.message}; re-anchoring against the new head`);
    const freshFiles = await client.listFiles(owner, repo, prNumber);
    const again = composeReview({ proposal, cfg, files: freshFiles, headSha: error.actual, owner, repo });
    return submitReview({ client, owner, repo, pr: prNumber, payload: again.payload, expectedHeadSha: error.actual });
  }
}
