/**
 * Review composition and policy.
 *
 * The agent proposes; this module decides what actually reaches GitHub. The default action on both
 * verdict axes is `hint`, because an approval from my account can clear a merge gate and a
 * requested change can block one, and a model should not move either by itself.
 */

import { anchorComment } from "../github/anchoring.mjs";
import { normaliseCitations } from "./links.mjs";

export const VERDICT_EVENT = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

const VERDICT_ACTION = {
  approve: (cfg) => cfg.reviews.approve,
  request_changes: (cfg) => cfg.reviews.requestChanges,
  comment: () => "submit",
};

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case- and whitespace-insensitive, tolerant of the punctuation a sentence ends with. */
function containsSentence(text, sentence) {
  const flatten = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const needle = flatten(sentence).replace(/[.,;:]+$/, "");
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}([.,;:!?]|\\s|$)`).test(flatten(text));
}

/** The configured sentence, word for word, somewhere in the body. */
function containsVerbatim(body, notice) {
  const flatten = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const needle = flatten(notice);
  return Boolean(needle) && flatten(body).includes(needle);
}

function verdictLineFor(verdict, action, cfg, proposal) {
  if (action !== "hint") return "";
  if (verdict === "approve") {
    // Phrase matching assumed a shape in a user-written sentence and was the wrong kind of clever. The
    // only check kept is the one that needs no assumption: the sentence is already there, say it once.
    // Phrasing an approval is the review's job, so an empty wording adds no sentence at all.
    const wording = String(cfg.reviews.hintWording.approve ?? "").trim();
    if (!wording) return "";
    return containsSentence(proposal?.body, wording) ? "" : wording;
  }
  if (verdict === "request_changes") {
    const blockers = (proposal?.blocking ?? []).filter(Boolean);
    const base = cfg.reviews.hintWording.requestChanges;
    if (!blockers.length) return base;
    const list = blockers.join("; ");
    // Long blocker lists are the inline comments restated. Keep the sentence short and point at them.
    if (list.length <= 160) return `${base} Blocking: ${list}`;
    return `${base} Blocking ${blockers.length} items, named in the inline comments.`;
  }
  return "";
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "onto", "are", "was", "have", "has", "not", "you", "your", "our", "its", "any", "all", "but"]);

/**
 * How much of a configured notice the review body already carries, counted in content words. Coverage
 * rather than phrasing: the agent may word the notice its own way, so no sentence shape is assumed.
 */
export function noticeCoverage(body, notice) {
  const words = String(notice ?? "").toLowerCase().match(/[\p{L}\p{N}'_-]{3,}/gu);
  const needed = [...new Set((words ?? []).filter((word) => !STOPWORDS.has(word)))];
  if (!needed.length) return 1;
  const hay = String(body ?? "").toLowerCase();
  const found = needed.filter((word) => new RegExp("\\b" + escapeForRegex(word) + "\\b").test(hay)).length;
  return found / needed.length;
}

/**
 * Where a notice belongs in the body: the opening block for the prefix, the closing block for the suffix.
 *
 * Reading the whole body would let one notice answer for both slots, which is how an intro and an outro
 * became the same thing: a review that opened with the outro text would not be asked for an outro.
 * A body of one block has no position to judge, so it is read as a whole.
 */
export function noticeRegion(body, slot) {
  const blocks = String(body ?? "").split(/\n[ \t]*\n/).filter((block) => block.trim());
  if (blocks.length < 2) return blocks.join("\n\n");
  return slot === "suffix" ? blocks.at(-1) : blocks[0];
}

/**
 * Decide which banner slots the harness has to supply. In authored mode the review is asked to write the
 * notice itself and only a slot it left out in its own place is filled, so a notice never appears twice.
 *
 * @returns {{ prefix: string, suffix: string, missing: string[], supplied: string[] }}
 */
export function planBanner({ cfg, proposal }) {
  const configured = {
    prefix: proposal.banner?.prefix ?? cfg.banner.prefix ?? "",
    suffix: proposal.banner?.suffix ?? cfg.banner.suffix ?? "",
  };
  const slots = { prefix: "", suffix: "", missing: [], supplied: [], verbatim: [] };
  for (const slot of ["prefix", "suffix"]) {
    const text = configured[slot];
    if (!text) continue;
    if (cfg.banner.mode === "appended") {
      slots[slot] = text;
      slots.supplied.push(slot);
      continue;
    }
    const carried = noticeCoverage(noticeRegion(proposal.body, slot), text) >= 0.6;
    // Pasting the configured sentence is not carrying it in the review's own words. It still goes to the
    // rewording pass, but the review is not counted as having left the disclosure out.
    const verbatim = carried && containsVerbatim(proposal.body, text);
    if (carried && !verbatim) continue;
    slots[slot] = text;
    if (!carried) slots.missing.push(slot);
    if (verbatim) slots.verbatim.push(slot);
    slots.supplied.push(slot);
  }
  return slots;
}

/** Assemble the published body. Empty slots are skipped, order is fixed. */
export function assembleBody({ prefix, body, verdictLine, suffix }) {
  return [prefix, body, verdictLine, suffix].map((part) => (part ?? "").trim()).filter(Boolean).join("\n\n");
}

/**
 * Validate a rephrased banner slot against the configured original.
 *
 * The rephrase call exists for text flow only. It must not add a claim, a commitment, a link or a
 * mention, so anything that was not in the source is a rejection and the literal text is used.
 */
export function validateBannerSlot(original, rewritten, { label = "banner" } = {}) {
  if (!original) return { ok: !rewritten, reason: rewritten ? `${label}: rephrased an empty slot` : "" };
  const text = (rewritten ?? "").trim();
  if (!text) return { ok: false, reason: `${label}: rephrase returned nothing` };
  if (text.split("\n").length > 2) return { ok: false, reason: `${label}: more than two lines` };
  if (text.length > original.length * 3 + 20) return { ok: false, reason: `${label}: far longer than the source` };

  const committed = /\b(approv\w*|merge\w*|lgtm|ship it|accept\w*)\b/i;
  if (committed.test(text) && !committed.test(original)) {
    return { ok: false, reason: `${label}: introduces a verdict or merge claim` };
  }
  if (/https?:\/\//.test(text) && !/https?:\/\//.test(original)) {
    return { ok: false, reason: `${label}: introduces a link` };
  }
  if (/@[a-z0-9-]{2,}/i.test(text) && !/@[a-z0-9-]{2,}/i.test(original)) {
    return { ok: false, reason: `${label}: introduces a mention` };
  }
  const tags = (s) => new Set([...String(s).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b/g)].map((m) => m[1].toLowerCase()));
  for (const tag of tags(text)) {
    if (!tags(original).has(tag)) return { ok: false, reason: `${label}: introduces <${tag}> markup` };
  }

  // A rewrite that shares no real wording with the source is a new sentence, not a rephrase.
  const STOP = new Set(["the", "this", "that", "with", "from", "for", "and", "not", "you", "your", "are", "was", "were", "will", "have", "been"]);
  const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOP.has(word)));
  const originalWords = words(original);
  const shared = [...words(text)].filter((word) => originalWords.has(word)).length;
  if (shared < 2) return { ok: false, reason: `${label}: shares no wording with the source` };
  return { ok: true, reason: "" };
}

/**
 * @param proposal   what the agent proposed (body, verdict, comments, blocking, gates)
 * @param cfg        validated config
 * @param files      `GET /pulls/N/files` result for the current head
 * @param headSha    the head the review is pinned to
 */
export function composeReview({ proposal, cfg, files, headSha, owner, repo, banner = null }) {
  const decisions = [];
  const notes = [];

  if (!VERDICT_EVENT[proposal?.verdict]) {
    throw new Error(`unknown verdict: ${proposal?.verdict}`);
  }

  const anchored = [];
  for (const proposed of proposal.comments ?? []) {
    const result = anchorComment(proposed, files);
    if (result.status === "dropped") {
      notes.push(`dropped comment: ${result.note}`);
      continue;
    }
    if (result.status === "adjusted") {
      result.comment.note = result.note;
      notes.push(`anchored comment: ${result.note}`);
    }
    if (proposed.suggestion) {
      // A suggestion block has to be the fenced last thing in the comment body.
      result.comment.body = `${result.comment.body.trim()}\n\n\`\`\`suggestion\n${proposed.suggestion}\n\`\`\``;
    }
    anchored.push(result.comment);
  }

  const cap = cfg.reviews.maxComments;
  const comments = anchored.slice(0, cap);
  if (anchored.length > cap) notes.push(`dropped ${anchored.length - cap} comments over maxComments=${cap}`);

  const action = VERDICT_ACTION[proposal.verdict](cfg);
  decisions.push(`verdict ${proposal.verdict} -> ${action}`);

  let event = "COMMENT";
  let verdictLine = "";
  if (action === "submit") {
    event = VERDICT_EVENT[proposal.verdict];
  } else if (action === "hint") {
    verdictLine = verdictLineFor(proposal.verdict, action, cfg, proposal);
  }

  // Citation form is mechanical, so it is fixed here rather than hoped for: a bare permalink inside a
  // sentence becomes an alt-text link, and a plain mention of a file this PR touches is pinned to the head
  // under review. Doing it before the gate means the gate, the artifact and GitHub all show one text.
  const knownPaths = new Set((files ?? []).map((file) => file.filename));
  let inlined = 0;
  let pinned = 0;
  const cite = (text) => {
    const result = normaliseCitations(text, { owner, repo, headSha, knownPaths });
    inlined += result.inlined;
    pinned += result.pinned;
    return result.text;
  };
  for (const comment of comments) comment.body = cite(comment.body);

  const slots = banner ?? planBanner({ cfg, proposal });
  if (slots.missing?.length) {
    const label = { prefix: "opening notice", suffix: "closing notice" };
    notes.push(`banner: the review did not carry its ${slots.missing.map((slot) => label[slot] ?? slot).join(" and ")}; the configured notice was added in its place`);
  }

  const body = assembleBody({
    prefix: slots.prefix,
    body: cite(proposal.body ?? ""),
    verdictLine,
    suffix: slots.suffix,
  });
  if (inlined || pinned) notes.push(`citations: ${inlined} bare permalink(s) given alt text, ${pinned} file mention(s) pinned to ${headSha.slice(0, 8)}`);

  if (!(proposal.body ?? "").trim() && !comments.length) {
    // A banner alone is not a review: refuse rather than post an empty check-in on someone's PR.
    throw new Error("proposed review is empty: no body and no comments");
  }

  const payload = { commit_id: headSha, event, body, comments };
  return {
    payload,
    decisions,
    notes,
    action,
    event,
    verdict: proposal.verdict,
    comments: payload.comments,
    // Kept so an approved review can be re-composed later without re-applying the banner twice.
    proposalBody: proposal.body ?? "",
    proposalBlocking: proposal.blocking ?? [],
  };
}
