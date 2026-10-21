/**
 * The local record of a review run.
 *
 * What the agent verified stays out of the PR and in here: gate runs, ticket coverage, the mapping
 * the policy applied, and every anchor it had to repair.
 */

import fs from "node:fs";
import path from "node:path";

export function renderArtifact({ pr, headSha, collector, composed, notes, decisions, gate, posted }) {
  const lines = [
    `# Review record: ${pr.repository}#${pr.number}`,
    "",
    `- PR: ${pr.html_url}`,
    `- Head: ${headSha}`,
    `- Proposed verdict: ${collector.verdict ?? "unset"}${collector.verdictReason ? ` (${collector.verdictReason})` : ""}`,
    `- Policy action: ${composed.action}, submitted event: ${composed.event}`,
    `- Posted: ${posted ? `${posted.state} ${posted.html_url}` : "no"}`,
    `- Gate: ${gate?.state ?? "not_required"}${gate?.gateId ? ` (${gate.gateId})` : ""}`,
    "",
    "## Composed review",
    "",
    composed.payload.body || "(empty body)",
    "",
    "## Inline comments",
    "",
  ];

  if (!composed.payload.comments.length) lines.push("(none)");
  for (const comment of composed.payload.comments) {
    const range = comment.start_line ? `${comment.start_line}-${comment.line}` : `${comment.line}`;
    lines.push(`### ${comment.path}:${range}`, "", comment.body, "");
  }

  if (collector.gates.length) {
    lines.push("## Gate runs", "", "| gate | result | evidence |", "| --- | --- | --- |");
    for (const entry of collector.gates) lines.push(`| ${entry.gate} | ${entry.result} | ${entry.evidence} |`);
    lines.push("");
  }

  if (collector.blocking.length) {
    lines.push("## Blocking items named by the model", "", ...collector.blocking.map((item) => `- ${item}`), "");
  }

  if (decisions.length) lines.push("## Policy decisions", "", ...decisions.map((entry) => `- ${entry}`), "");
  if (notes.length) lines.push("## Harness notes", "", ...notes.map((entry) => `- ${entry}`), "");

  return lines.join("\n");
}

export function writeArtifact({ dir, pr, headSha, ...rest }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pr.repository.replace(/\//g, "-")}-${pr.number}-${headSha.slice(0, 8)}.md`);
  fs.writeFileSync(file, renderArtifact({ pr, headSha, ...rest }));
  return file;
}
