/**
 * The task prompt. Everything the agent needs that is not in the agent file: what to review, what
 * the diff looks like, what was already said on the PR, and what context was carried over.
 */

import { commentableLines } from "../github/anchoring.mjs";

export function buildTaskPrompt({ pr, files, checkoutDir, headSha, prior = {}, reRequest = null, context = null, compareDir = null, lint = null, resume = null, writableRoots = [], allowHosts = [] }) {
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

  if (writableRoots.length) {
    const roots = writableRoots.length === 1 ? writableRoots[0] : `${writableRoots.slice(0, -1).join(", ")} and ${writableRoots.at(-1)}`;
    sections.push(
      [
        `Scratch space. Writing is allowed under ${roots}: notes, fetched refs, patched copies of a`,
        `checkout with its manifests, build and tool caches. A verb that rewrites a manifest`,
        `'go mod tidy' or 'npm install' is fine in a copy there and refused in the checkout, which is`,
        `how you check whether the change would come out clean. A tool this image does not carry is`,
        `yours to fetch into those roots, from: ${allowHosts.join(", ")}. Anywhere else is refused by the`,
        `tool policy and lands in the harness notes, so do not spend a turn probing it. Never write`,
        `inside the checkout itself.`,
      ].join("\n"),
    );
  }

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

  if (lint) sections.push(lintBlock(lint));

  if (prior.reviews?.length || prior.comments?.length) {
    const existing = [
      ...prior.reviews.map((review) => `review ${review.id} by ${review.user?.login}: ${review.state}`),
      ...prior.comments.map((comment) => `inline on ${comment.path}:${comment.line}: ${String(comment.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`),
    ];
    sections.push(["Already on this PR (do not repeat these findings):", ...existing].join("\n"));
  } else {
    sections.push("No review and no inline comment exists on this PR yet.");
  }

  if (reRequest) {
    sections.push(
      [
        `Re-review: the review was requested again at ${reRequest.askedAt}, after an earlier pass of this`,
        `same head at ${reRequest.handledAt}. The entries above include that pass, so repeating them adds`,
        `nothing: say what has changed since, and whether the earlier concerns still stand.`,
      ].join("\n"),
    );
  }

  if (resume) {
    sections.push(
      resume.scratchKept
        ? [
            `Resumed run: an earlier pass of this review was interrupted${resume.at ? ` at ${resume.at}` : ""}`,
            "because the inference server was occupied. Its transcript is part of this session and its",
            `scratch tree is still in place at ${checkoutDir}: the files and comparison copies it read are`,
            "still there, so continue where it stopped instead of repeating finished steps.",
          ].join("\n")
        : [
            `Resumed run: an earlier pass of this review was interrupted${resume.at ? ` at ${resume.at}` : ""}`,
            "because the inference server was occupied. Its transcript is part of this session, so continue",
            "where it stopped rather than repeating finished steps. Its scratch and comparison directories are",
            "gone: re-run any command whose output you quote, and do not rely on results you cannot reproduce.",
          ].join("\n"),
    );
  }

  if (context) {
    const earlier = context.review?.checkout_dir || "an earlier scratch tree";
    sections.push(
      [
        `Carried-over context: ${context.description}`,
        context.instructions,
        `That session's paths (${earlier}) were one run's scratch area and no longer exist. Read only`,
        `from this checkout and this run's scratch roots, and re-run any command whose output the earlier`,
        `session is quoting rather than trusting the file it names.`,
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

/**
 * What the model may assume about the linter. A v1 binary cannot load a v2 config, which is a
 * tooling gap rather than a defect in the branch.
 */
function lintBlock(lint) {
  const lines = [];
  if (lint.requestedVersion) lines.push(`Linting. This repository pins golangci-lint ${lint.requestedVersion} in ${lint.source}.`);
  else lines.push(`Linting. No linter version is pinned (${lint.source}), so the image's golangci-lint is what you get.`);

  if (lint.configSchema) lines.push(`Its config ${lint.configSchema.source} declares schema version ${lint.configSchema.major}, so only a matching major can load it.`);
  if (lint.installedPath) lines.push(`Use ${lint.installedPath} for the lint gate; the harness installed it for this run.`);
  if (lint.note) lines.push(`Tooling note: ${lint.note}.`);
  if (lint.conflict) {
    const pins = lint.pins.map((pin) => `${pin.version} (${pin.source})`).join(", ");
    lines.push(`The pins disagree (${pins}). Run the gate the way CI runs it, and say which version you used.`);
  }
  lines.push("A linter that cannot start, or a version that is unavailable here, is a tooling gap: record the gate as not_run with the reason, and do not report it as a defect in this change.");
  return lines.join("\n");
}

export function extractTicketKeys(text) {
  const keys = new Set();
  for (const match of String(text).matchAll(/\b([A-Z][A-Z0-9]{1,15}-\d+)\b/g)) keys.add(match[1]);
  return [...keys];
}
