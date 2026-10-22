/**
 * Telegram presentation.
 *
 * Kept apart from the transport so the formatting and the callback vocabulary are testable without a
 * server. Telegram's HTML subset is small: b, i, code, pre, a, blockquote. Anything else shows as text.
 */

const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FILE_REF = /\b([\w./-]+\.(?:go|mod|sum|yml|yaml|json|sql|md|toml|sh|tf)):(\d+)(?:-(\d+))?/g;

/** Escape first, then mark up: the code tags must not be built out of untrusted text. */
function withCodeRefs(escaped) {
  return escaped.replace(FILE_REF, (_match, path, from, to) => `<code>${path}:${from}${to ? `-${to}` : ""}</code>`);
}

const firstLine = (body) => String(body ?? "").split("\n")[0].trim();

export function refOf(comment) {
  const range = comment.start_line && comment.start_line !== comment.line ? `${comment.start_line}-${comment.line}` : `${comment.line}`;
  return `${comment.path}:${range}`;
}

const INLINE_BLOCK = /^Inline comments \(\d+\):$/;

/**
 * The gate message: the PR as a link, the verdict line in bold, the body as written, then one numbered
 * line per finding, which is also the button that opens it.
 *
 * The summary's own inline-comment block is dropped rather than duplicated: the list below carries the
 * same positions, and the button carries the whole text.
 *
 * @param summary the harness summary for this gate
 * @param comments findings to list, already capped by the caller
 * @param maxFindings how many findings the list covers before the rest are only reachable by number
 */
export function summaryHtml(summary, { comments = [], maxFindings = 0 } = {}) {
  const source = String(summary ?? "").split("\n");
  const kept = [];
  for (let index = 0; index < source.length; index += 1) {
    if (INLINE_BLOCK.test(source[index])) {
      index += 1;
      while (index < source.length && source[index].startsWith("  ")) index += 1;
      index -= 1;
      continue;
    }
    kept.push(source[index]);
  }

  const out = kept.map((line) => {
    const pr = /^PR: (https?:\/\/\S+)$/.exec(line);
    if (pr) {
      // The link carries the name, so the message reads like the pull request rather than a bare target.
      const named = /\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(pr[1]);
      const label = named ? `${named[1]}/${named[2]}#${named[3]}` : "pull request";
      return `<a href="${pr[1]}">${label}</a>`;
    }
    if (line.startsWith("Model verdict:")) return `<b>${withCodeRefs(escapeHtml(line))}</b>`;
    return withCodeRefs(escapeHtml(line));
  });

  // The list mirrors the buttons: a finding without a button is not reachable, so it is not listed either.
  const listed = maxFindings > 0 ? comments.slice(0, maxFindings) : comments;
  if (listed.length) {
    out.push("");
    out.push(...listed.map((comment, index) => `${index + 1}. <code>${escapeHtml(refOf(comment))}</code> ${escapeHtml(firstLine(comment.body).slice(0, 90))}`));
    const hidden = comments.length - listed.length;
    if (hidden > 0) out.push(escapeHtml(`…${hidden} more findings, tap their number.`));
  }
  return out.join("\n");
}

/** One finding on its own, in place of the summary. */
export function findingHtml(gate, comment, index, total) {
  // Telegram's HTML subset has no <br>: a newline stays a newline, inside a blockquote or out of one.
  const body = escapeHtml(String(comment.body ?? "").trim());
  return [
    `<b>Finding ${index + 1} of ${total}</b>`,
    `<code>${escapeHtml(refOf(comment))}</code> on gate ${escapeHtml(gate.id)}`,
    "",
    `<blockquote>${body}</blockquote>`,
  ].join("\n");
}

export function decisionRows(gateId) {
  return [
    { text: "✅ approve", callback_data: `ap:${gateId}` },
    { text: "✖ reject", callback_data: `rj:${gateId}` },
    { text: "⏳ hold", callback_data: `hd:${gateId}` },
  ];
}

export function findingRows(gateId, count, perRow = 5) {
  const rows = [];
  for (let start = 0; start < count; start += perRow) {
    rows.push(Array.from({ length: Math.min(perRow, count - start) }, (_, offset) => ({
      text: `${start + offset + 1}`,
      callback_data: `fw:${gateId}:${start + offset}`,
    })));
  }
  return rows;
}

export function backRows(gateId, count) {
  return [{ text: "◀ back", callback_data: `bk:${gateId}` }, ...(count > 5 ? [{ text: "findings", callback_data: `ls:${gateId}` }] : [])];
}

/**
 * Callback data is at most 64 bytes, so it carries a two-letter verb, the short gate id, and a finding
 * index. Anything longer than the budget is a bug in the caller, not something to truncate.
 */
export function parseCallback(data) {
  const text = String(data ?? "");
  const decision = /^(ap|rj|hd):([0-9a-f-]{4,32})$/.exec(text);
  if (decision) {
    const state = { ap: "approved", rj: "rejected", hd: "held" }[decision[1]];
    return { kind: "decide", state, gateId: decision[2] };
  }
  const finding = /^fw:([0-9a-f-]{4,32}):(\d{1,3})$/.exec(text);
  if (finding) return { kind: "finding", gateId: finding[1], index: Number(finding[2]) };
  const back = /^bk:([0-9a-f-]{4,32})$/.exec(text);
  if (back) return { kind: "back", gateId: back[1] };
  const list = /^ls:([0-9a-f-]{4,32})$/.exec(text);
  if (list) return { kind: "back", gateId: list[1] };
  return null;
}

export const toastFor = (state) => ({ approved: "approved", rejected: "rejected", held: "on hold" })[state] ?? state;
