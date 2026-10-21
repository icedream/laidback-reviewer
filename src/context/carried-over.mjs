/**
 * Carrying context forward.
 *
 * The state database holds what this bot concluded about a PR before. A Pi session file holds how the
 * agent got there, and costs decode time in proportion to its size.
 *
 * Priority order: the same PR at an earlier head, then a stack sibling, then the same branch, then a
 * ticket in common, then changed-file overlap above context.minScore.
 */

import fs from "node:fs";
import { extractTicketKeys } from "../agent/prompt.mjs";

const PRIORITIES = [
  { kind: "same_pr", label: "the same PR at an earlier head" },
  { kind: "stack_sibling", label: "a sibling PR in this stack" },
  { kind: "same_branch", label: "the same branch" },
  { kind: "same_ticket", label: "a PR sharing this ticket" },
  { kind: "file_overlap", label: "an earlier review that touched the same files" },
];

function estimateTokens(file) {
  try {
    return Math.floor(fs.statSync(file).size / 4);
  } catch {
    return Infinity;
  }
}

function matchKind(review, { pr, stack, ticketKeys, changedPaths }) {
  if (review.crossRepo) return "same_ticket";
  if (review.pr === pr.number && review.head_sha !== headOf(pr)) return "same_pr";
  if (stack.siblings.includes(review.pr)) return "stack_sibling";
  if (review.branch && review.branch === pr.head.ref) return "same_branch";
  if (shared(review.body, ticketKeys).length) return "same_ticket";
  return "file_overlap";
}

const headOf = (pr) => pr.head.sha;

function shared(text, keys) {
  const found = new Set(extractTicketKeys(String(text ?? "").slice(0, 4000)));
  return keys.filter((key) => found.has(key));
}

function overlapScore(review, changedPaths) {
  if (!changedPaths.length) return 0;
  const before = new Set(changedPaths);
  return [...before].filter((path) => (review.commentPaths ?? []).includes(path)).length / before.size;
}

/**
 * @param cfg validated config
 * @param store state database
 * @returns the carried-over context, or { matched: false } when nothing qualifies
 */
export function pickContext({ cfg, store, pr, stack, files, now = new Date() }) {
  if (!cfg.context.enabled) return { matched: false, reason: "context.enabled=false" };
  if (!pr.owner || !pr.repo) return { matched: false, reason: "the PR view carries no owner/repo to query by" };

  const sinceIso = new Date(now.getTime() - cfg.context.maxAgeDays * 86_400_000).toISOString();
  const ticketKeys = extractTicketKeys(`${pr.title}\n${pr.body ?? ""}\n${pr.head.ref}`);
  const changedPaths = files.map((file) => file.filename);
  const enrich = (row) => ({ ...row, commentPaths: store.commentsFor(row.id).map((comment) => comment.path) });
  const candidates = store
    .recentReviews({ owner: pr.owner, repo: pr.repo, sinceIso })
    .map(enrich)
    .filter((row) => row.head_sha !== headOf(pr));

  if (cfg.context.allowCrossRepo) {
    // A ticket that spans services is the only cross-repo signal worth following: what carries over
    // is the requirement, not the code. Anything weaker is noise from an unrelated repository.
    for (const row of store.recentReviews({ sinceIso }).map(enrich)) {
      if (row.head_sha === headOf(pr)) continue;
      if (row.owner === pr.owner && row.repo === pr.repo) continue;
      if (!shared(row.body, ticketKeys).length) continue;
      candidates.push({ ...row, crossRepo: true });
    }
  }

  if (!candidates.length) return { matched: false, reason: "no review of this repository inside the context window" };

  let best = null;
  for (const row of candidates) {
    const kind = matchKind(row, { pr, stack, ticketKeys, changedPaths });
    const score = kind === "file_overlap" ? overlapScore(row, changedPaths) : 1;
    if (kind === "file_overlap" && score * 100 < cfg.context.minScore) continue;
    const rank = PRIORITIES.findIndex((entry) => entry.kind === kind);
    if (!best || rank < best.rank || (rank === best.rank && row.created_at > best.created_at)) {
      best = { row, kind, rank, score };
    }
  }

  if (!best) return { matched: false, reason: `no candidate reached minScore=${cfg.context.minScore}` };

  const label = PRIORITIES[best.rank].label;
  const tokens = best.row.session_file ? estimateTokens(best.row.session_file) : Infinity;
  // A session from another repository would replay the wrong checkout into the conversation, so
  // cross-repo context is always the digest.
  const wantFork = !best.row.crossRepo && (cfg.context.mode === "fork" || (cfg.context.mode === "auto" && tokens <= cfg.context.maxForkTokens));
  const canFork = wantFork && Number.isFinite(tokens);
  const mode = canFork ? "fork" : "digest";

  return {
    matched: true,
    mode,
    review: best.row,
    kind: best.kind,
    crossRepo: Boolean(best.row.crossRepo),
    tokens: Number.isFinite(tokens) ? tokens : null,
    description: `Continuing from an earlier look: ${label}${best.row.crossRepo ? ` in ${best.row.owner}/${best.row.repo}` : ""}, PR #${best.row.pr} at head ${best.row.head_sha.slice(0, 8)}, verdict ${best.row.verdict} (${best.row.action}, ${best.row.posted ? "posted" : "not posted"}).`,
    instructions: canFork
      ? "That earlier session is in your conversation. Re-read the current head first and diff it against what you already covered, then review only what changed and what still stands."
      : digestFor(best.row, store, cfg),
  };
}

/**
 * The findings as data rather than as a transcript. Above the fork budget this replaces replaying a
 * month of tool calls, which costs minutes of prompt processing to convey less than this list.
 */
function digestFor(row, store, cfg) {
  const comments = store.commentsFor(row.id);
  const lines = [
    "An earlier review of this repository concluded the following. Check each point against the current head before repeating it, and drop the ones the change fixed:",
    ...comments.map((comment) => `- ${comment.path}:${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}: ${comment.body.split("\n")[0].slice(0, 180)}`),
  ];
  if (row.body) lines.push("", "Its body said:", row.body.split("\n").slice(0, 6).join("\n"));
  return lines.join("\n");
}
