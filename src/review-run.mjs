/**
 * One review run.
 *
 * Fetch → agent session → proposal → policy → gate → post. The agent never reaches GitHub: it records
 * a proposal, and only the last step can write, and only if the policy and the gate allow it.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadAgentDef, nonInteractiveContract } from "./agent/agent-def.mjs";
import { createReviewGuard } from "./agent/guard.mjs";
import { createProgress } from "./agent/progress.mjs";
import { promptWithModelRetry } from "./agent/model-retry.mjs";
import { modelServerStatus, resolveModelServer } from "./agent/model-server.mjs";
import { ModelBusyError } from "./agent/run-watch.mjs";
import { buildTaskPrompt } from "./agent/prompt.mjs";
import { rephraseBanner } from "./agent/rephrase.mjs";
import { REVIEW_TOOLS, createReviewSession } from "./agent/runtime.mjs";
import { createProposalCollector, createReviewTools } from "./agent/tools.mjs";
import { configureGitAuth, configureGoModules, prepareComparisonDir } from "./checkout.mjs";
import { resolveLintTool } from "./tools/golangci-lint.mjs";
import { pickContext } from "./context/carried-over.mjs";
import { resolveStack } from "./context/stack.mjs";
import { HeadMovedError, submitReview } from "./github/poster.mjs";
import { createGate, renderGateSummary } from "./gate/gate.mjs";
import { writeArtifact } from "./proposal/artifact.mjs";
import { composeReview } from "./proposal/policy.mjs";

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

export async function runReview({ cfg, store, client, task, piAgentDir, artifactDir, slack = null, log = console.error }) {
  const { owner, repo, pr: prNumber, checkoutDir } = task;
  const prJson = await client.getPull(owner, repo, prNumber);
  const pr = toPrView(prJson, { owner, repo });
  const headSha = pr.head.sha;

  if (pr.draft && cfg.trigger.skipDraft) {
    return { skipped: "draft", pr };
  }

  const files = await client.listFiles(owner, repo, prNumber);
  const gate = createGate({ cfg, store, log, slack });

  const preGate = await gate.open({
    stage: "before_review",
    reviewId: null,
    summary: `Review requested for ${pr.repository}#${pr.number} at ${headSha.slice(0, 8)}: ${pr.title}`,
  });
  if (preGate.state !== "approved") {
    return { skipped: "gate_queued", gate: preGate, pr };
  }

  const [reviews, comments] = await Promise.all([
    client.listReviews(owner, repo, prNumber),
    client.listInlineComments(owner, repo, prNumber),
  ]);

  if (store.alreadyHandled({ owner, repo, pr: prNumber, head_sha: headSha }) && !cfg.reviews.rereviewOnPush) {
    return { skipped: "already_reviewed", pr };
  }

  const agentDef = loadAgentDef(cfg.agent.agentDir, cfg.agent.name);

  // Comparison fetches (trunk, tags, a dependency's own repository) run under the comparison root
  // with the same read-only credential, so a version claim is read from source rather than inferred.
  const compareDir = prepareComparisonDir({ cfg, log });
  if (cfg.checkout.mode === "clone") {
    configureGitAuth({ cfg, dir: checkoutDir, log });
    configureGoModules({ cfg, dir: checkoutDir, log });
  }

  const collector = createProposalCollector();
  // One list for both halves: the guard allows these paths and the prompt names them, so the agent is
  // not discovering the write boundary by hitting it. The toolchain install dir is included because a
  // repository that pins a version the image does not carry has to be able to fetch it itself.
  const writableRoots = [cfg.checkout.scratch, cfg.toolchain.installDir, "/tmp"];
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

  // Context is resolved before the session is built, because the choice decides which session file
  // the agent starts from. The stack walk answers "which PR is this stacked on", which is the one
  // place the shared code was read first.
  const repoInfo = await client.getRepo(owner, repo);
  const stack = await resolveStack({ client, owner, repo, pr, defaultBranch: repoInfo.default_branch, log });
  const context = pickContext({ cfg, store, pr, stack, files });
  log(context.matched ? `context: ${context.mode} from #${context.review.pr} (${context.kind})` : `context: none (${context.reason})`);

  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir,
    headSha,
    prior: { reviews, comments },
    compareDir,
    writableRoots,
    allowHosts: cfg.tools.allowHosts,
    lint: lint.mode === "off" ? null : lint,
    context: context.matched ? { description: context.description, instructions: context.instructions } : null,
  });

  // The model slot is shared with the interactive session, and a request queued behind another still
  // occupies it. The queue is read before anything is sent, and again by the run watchdog.
  const modelProbe = () =>
    modelServerStatus({
      server: resolveModelServer({ piAgentDir, provider: cfg.agent.model.provider, modelId: cfg.agent.model.id, statusUrl: cfg.agent.model.statusUrl }),
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

  const sessionManager =
    context.matched && context.mode === "fork" && cfg.context.sessionDir
      ? SessionManager.forkFrom(context.review.session_file, checkoutDir, cfg.context.sessionDir)
      : cfg.context.sessionDir
        ? SessionManager.create(checkoutDir, cfg.context.sessionDir)
        : SessionManager.inMemory(checkoutDir);

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
  let busyRetriesUsed = 0;
  try {
    progress = createProgress({ log, mode: cfg.logging.progress, heartbeatMs: cfg.logging.heartbeatMs });
    stopProgress = session.subscribe(progress.handle);

    log(`review ${pr.repository}#${pr.number} at ${headSha.slice(0, 8)}: agent ${agentDef.name}, ${files.length} changed files`);
    if (cfg.logging.level === "debug") {
      log(`debug: checkout ${checkoutDir}, comparison ${compareDir}, linter ${lint.mode}${lint.requestedVersion ? ` ${lint.requestedVersion}` : " (image)"}`);
      log(`debug: context ${context.matched ? `${context.mode} from #${context.review.pr} (${context.kind})` : `none (${context.reason})`}`);
    }
    busyRetriesUsed = await promptWithModelRetry({ session, cfg, collector, prompt, log, probe: modelProbe });
  } finally {
    // A cancelled or failed turn must leave nothing armed: a heartbeat that outlives the run keeps the
    // process alive and prints "still working" forever.
    progress?.stop();
    stopProgress?.();
    session.dispose();
  }

  const notes = [];
  if (lint.note) notes.push(`lint tooling: ${lint.note}`);
  if (lint.conflict) notes.push(`linter pins disagree: ${lint.pins.map((pin) => `${pin.version} (${pin.source})`).join(", ")}`);
  if (busyRetriesUsed) notes.push(`model endpoint failed ${busyRetriesUsed} time(s); the session was asked to continue`);
  if (!collector.submitted) notes.push("the run ended without review_submit; composing from what was recorded");
  for (const entry of guard.log) {
    // The command is kept so a denied call can be reviewed: a false positive in the deny list would
    // otherwise look like the model misbehaving.
    const detail = `${entry.tool}: ${entry.reason}${entry.command ? ` (${String(entry.command).slice(0, 120)})` : ""}`;
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

  if (cfg.banner.rephrase) {
    try {
      proposal.banner = await rephraseBanner({ cfg, agentDir: piAgentDir, cwd: checkoutDir, prRef: `${pr.repository}#${pr.number}`, log });
    } catch (error) {
      // A failed rewrite is a wording problem, not a reason to lose the review.
      notes.push(`banner rephrase failed: ${error.message}; using the configured text`);
    }
  }

  const composed = composeReview({ proposal, cfg, files, headSha });
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
    stackKey: stack.key,
  });
  store.markSeen({ owner, repo, pr: prNumber, head_sha: headSha });

  const gateState = await gate.open({
    stage: "before_post",
    reviewId,
    summary: renderGateSummary({ pr, headSha, composed, notes, decisions: composed.decisions }),
  });

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
    const again = composeReview({ proposal, cfg, files: freshFiles, headSha: error.actual });
    return submitReview({ client, owner, repo, pr: prNumber, payload: again.payload, expectedHeadSha: error.actual });
  }
}
