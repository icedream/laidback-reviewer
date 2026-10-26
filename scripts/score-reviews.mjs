#!/usr/bin/env node
/**
 * Score composed reviews for length and for what they spend words on.
 *
 * The prose rules in the review agent say what to leave out, and a rule that is not obeyed is invisible
 * unless something measures it. This reads the records the bot writes under `data/reviews/` and reports,
 * per review, the body split by paragraph and the comments by size, with flags for the shapes that keep
 * showing up: a lint or test run narrated in the body, a gate result quoted twice, a body that never asks
 * for anything.
 *
 *   node scripts/score-reviews.mjs                       # data/reviews
 *   node scripts/score-reviews.mjs /work/probe-reviews   # a dry-run probe
 */

import fs from "node:fs";
import path from "node:path";

const TOOL_RUN = /\b(golangci-lint|go test|go vet|gofmt|gofumpt|nolint|only-new-issues|GOTOOLCHAIN|go mod)\b/;
const GATE_RECAP = /\b(fails?|passes?|green|passed|failed)\b[^.]{0,80}\bat\b [0-9a-f]{7,40}|\bat [0-9a-f]{7,40}\b[^.]{0,80}\b(fails?|passes?|green|passed|failed)\b/;
const ASKS = /\b(worth|worthwhile|consider|would want|ask|please|should|fine to keep|not a blocker|nit|follow-up)\b/i;
const HARNESS_LINES = [/^If this were a human review/, /^I would want to request changes/, /^Verdict:/];

const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;
const sentences = (text) => (String(text ?? "").match(/[.!?](\s|$)/g) ?? []).length;
const links = (text) => (String(text ?? "").match(/https?:\/\//g) ?? []).length;

function splitSections(text) {
  const body = text.split("## Composed review")[1]?.split("## Inline comments")[0] ?? "";
  const inline = text.split("## Inline comments")[1]?.split(/\n## (?:Gate runs|Policy decisions|Harness notes)/)[0] ?? "";
  const comments = inline
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const [position, ...rest] = chunk.split("\n");
      return { position: position.trim(), text: rest.join("\n").trim() };
    })
    .filter((comment) => comment.text);
  // The first paragraph is the disclosure notice the review carries, and the harness appends its verdict
  // line at the end; neither is prose the review agent chose to write.
  const paragraphs = body
    .trim()
    .split(/\n\n+/)
    .filter((p) => p.trim() && !HARNESS_LINES.some((pattern) => pattern.test(p.trim())));
  return { notice: paragraphs.shift() ?? "", paragraphs, comments };
}

function scoreFile(file) {
  const { notice, paragraphs, comments } = splitSections(fs.readFileSync(file, "utf8"));
  const body = paragraphs.join("\n");
  const flagged = [];
  if (TOOL_RUN.test(body)) flagged.push("lint/test run narrated in the body");
  if (GATE_RECAP.test(body)) flagged.push("gate result quoted in the body");
  if (body && !ASKS.test(body)) flagged.push("body asks for nothing");
  const overlong = comments.filter((comment) => words(comment.text) > 80 || links(comment.text) >= 4);
  if (overlong.length) flagged.push(`${overlong.length} comment(s) over 80 words or 4 links`);
  return {
    name: path.basename(file, ".md").replace(/^GameFabric-/, ""),
    noticeWords: words(notice),
    bodyWords: words(body),
    paragraphs: paragraphs.map((p) => words(p)),
    bodySentences: sentences(body),
    asks: ASKS.test(body) ? "yes" : "no",
    comments: comments.map((comment) => `${words(comment.text)}w/${sentences(comment.text)}s/${links(comment.text)}L`),
    flags: flagged,
  };
}

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["data/reviews"];
const rows = dirs
  .flatMap((dir) => (fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f)) : [dir]))
  .map(scoreFile);

for (const row of rows) {
  console.log(
    [
      row.name.padEnd(46),
      `body ${String(row.bodyWords).padStart(4)}w`,
      `(${row.paragraphs.join("+")})`,
      `${row.bodySentences}s`,
      `comments ${row.comments.length ? row.comments.join(" ") : "-"}`.padEnd(28),
      row.flags.length ? row.flags.join("; ") : "",
    ].join("  "),
  );
}
const total = rows.reduce((sum, row) => sum + row.bodyWords, 0);
console.log(`\n${rows.length} reviews, mean body ${Math.round(total / rows.length)} words`);
