/**
 * The task prompt. Everything the agent needs that is not in the agent file: what to review, what
 * the diff looks like, what was already said on the PR, and what context was carried over.
 */

import { commentableLines } from "../github/anchoring.mjs";

export function buildTaskPrompt({ pr, files, checkoutDir, headSha, prior = {}, context = null, compareDir = null }) {
  const sections = [];

  sections.push(`Review pull request #${pr.number} in ${pr.repository}.`);
  sections.push(
    [
      `Head: ${headSha} (${pr.head.ref})`,
      `Base: ${pr.base.ref}`,
      `Title: ${pr.title}`,
      pr.draft ? "Draft: yes" : "Draft: no",
    ].join("\n"),
  );

  sections.push(["PR body:", pr.body?.trim() ? pr.body.trim() : "(empty)"].join("\n"));

  const ticketKeys = extractTicketKeys(`${pr.title}\n${pr.body ?? ""}\n${pr.head.ref}`);
  if (ticketKeys.length) {
    sections.push(`Ticket keys referenced: ${ticketKeys.join(", ")}. Read each one before mapping requirements to code.`);
  }

  sections.push(
    [
      `Checkout: ${checkoutDir}`,
      `Work in a detached temporary worktree for branch state; never change this tree, and never push.`,
      `Changed files (from the API diff, with the line numbers GitHub accepts for inline comments):`,
      ...files.map((file) => {
        const lines = commentableLines(file);
        const shown = lines.length > 24 ? `${lines.slice(0, 12).join(",")} … ${lines.slice(-12).join(",")} (${lines.length} total)` : lines.join(",");
        return `- ${file.filename} [${file.status}, +${file.additions}/-${file.deletions}] commentable RIGHT lines: ${shown || "(none)"}`;
      }),
    ].join("\n"),
  );

  if (compareDir) {
    sections.push(
      [
        `Comparing versions. Put anything you fetch outside this PR in ${compareDir}, never in the`,
        `checkout. The credential available to git is read-only, so fetch, clone and detached`,
        `worktrees work and pushes cannot. Useful moves:`,
        `- trunk as it is now: \`git fetch origin ${pr.base.ref} && git diff origin/${pr.base.ref}...${headSha.slice(0, 12)}\``,
        "- whether a finding predates this PR: `git log -S<pattern> --oneline origin/<base>` and `git grep <pattern> origin/<base>`",
        "- a dependency whose version changed: clone or fetch that project into the comparison root and diff its old and new tags, so the claim about the dependency is read from its source and not inferred from the version number",
        "",
        `Permalinks: pin a precedent to the base SHA ${pr.base.sha}, and code this change introduces to the head SHA ${headSha}. A commit SHA stays reachable after the squash; a branch link does not.`,
      ].join("\n"),
    );
  }

  if (prior.reviews?.length || prior.comments?.length) {
    const existing = [
      ...prior.reviews.map((review) => `review ${review.id} by ${review.user?.login}: ${review.state}`),
      ...prior.comments.map((comment) => `inline on ${comment.path}:${comment.line}: ${String(comment.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`),
    ];
    sections.push(["Already on this PR (do not repeat these findings):", ...existing].join("\n"));
  } else {
    sections.push("No review and no inline comment exists on this PR yet.");
  }

  if (context) {
    sections.push(
      [
        `Carried-over context: ${context.description}`,
        context.instructions,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  sections.push(
    [
      "Propose the review through the review_propose_* tools, then call review_submit. The standard",
      "above is unchanged: verdict first, one concrete issue per comment, evidence over method.",
      "Two harness differences: a gate run that passed goes to review_record_gate and never onto the",
      "PR, and the harness may add its own line about whether the verdict is being sent, so do not",
      "write that a review was posted or that an approval stands.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export function extractTicketKeys(text) {
  const keys = new Set();
  for (const match of String(text).matchAll(/\b([A-Z][A-Z0-9]{1,15}-\d+)\b/g)) keys.add(match[1]);
  return [...keys];
}
