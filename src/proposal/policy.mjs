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
const distinctiveWords = (text) =>
  [...new Set((String(text ?? "").toLowerCase().match(/[\p{L}\p{N}'_-]{3,}/gu) ?? []).filter((word) => !STOPWORDS.has(word)))];

/**
 * How much of a notice a piece of text states: the fraction of its distinctive words, and how many it
 * states at all. Word forms count, so "tested" answers "testing".
 */
export function noticePresence(region, notice) {
  const needed = distinctiveWords(notice);
  if (!needed.length) return { coverage: 1, hits: 1 };
  const hay = String(region ?? "").toLowerCase();
  const hits = needed.filter((word) => new RegExp("\\b" + escapeForRegex(word) + "\\w*").test(hay)).length;
  return { coverage: hits / needed.length, hits };
}

export function noticeCoverage(body, notice) {
  return noticePresence(body, notice).coverage;
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
 * Put text in the block where a notice belongs, leaving the rest of the body alone.
 */
export function replaceRegion(body, slot, text) {
  const blocks = String(body ?? "").split(/\n[ \t]*\n/);
  const filled = blocks.filter((block) => block.trim());
  if (!filled.length) return String(text ?? "").trim();
  if (filled.length === 1) return String(text ?? "").trim();
  blocks[blocks.indexOf(slot === "suffix" ? filled.at(-1) : filled[0])] = String(text ?? "").trim();
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Decide which banner slots the harness has to supply. In authored mode the review is asked to write the
 * notice itself: a slot it left out is filled, and a slot it wrote is only ever reworded in place, so a
 * notice never appears twice.
 *
 * @returns {{ prefix: string, suffix: string, missing: string[], supplied: string[], inPlace: string[],
 *   verbatim: string[], draft: Record<string, string>, reworded: string[] }}
 */
export function planBanner({ cfg, proposal }) {
  const configured = {
    prefix: proposal.banner?.prefix ?? cfg.banner.prefix ?? "",
    suffix: proposal.banner?.suffix ?? cfg.banner.suffix ?? "",
  };
  const slots = { prefix: "", suffix: "", missing: [], supplied: [], verbatim: [], inPlace: [], draft: {}, reworded: [] };
  for (const slot of ["prefix", "suffix"]) {
    const text = configured[slot];
    if (!text) continue;
    if (cfg.banner.mode === "appended") {
      slots[slot] = text;
      slots.supplied.push(slot);
      continue;
    }
    const region = noticeRegion(proposal.body, slot);
    const { coverage, hits } = noticePresence(region, text);
    // What matters is that the disclosure is stated there, not that the words match: a rewrite that keeps
    // the claims shares few of them by design. Two distinctive words in a notice-sized block is that
    // disclosure, restated.
    const carried = coverage >= 0.6 || (hits >= 2 && region.trim().length <= 400);
    const verbatim = containsVerbatim(proposal.body, text);

    if (!carried) {
      slots[slot] = text;
      slots.missing.push(slot);
      slots.supplied.push(slot);
      continue;
    }
    if (verbatim || cfg.banner[`rephrase${slot === "prefix" ? "Prefix" : "Suffix"}`]) {
      // The review put a notice in its place. Nothing is ever added beside it: at most the block itself is
      // replaced by one reworded sentence.
      slots[slot] = text;
      slots.inPlace.push(slot);
      slots.supplied.push(slot);
      if (verbatim) slots.verbatim.push(slot);
      else slots.draft[slot] = region;
    }
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
export function validateBannerSlot(original, rewritten, { label = "banner", draft = "" } = {}) {
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

  // Changing the words is the job, so overlap is only a floor: some claim of the source, or of the draft
  // the review wrote, has to survive. What must not appear is a promise the source never made.
  const known = new Set([...distinctiveWords(original), ...distinctiveWords(draft)]);
  if (!distinctiveWords(text).some((word) => known.has(word))) {
    return { ok: false, reason: `${label}: no claim from the source survives` };
  }
  const promise = /\b(i will|i'll|i've|i have|going to|fixed|updated|patched)\b/i;
  if (promise.test(text) && !promise.test(original) && !promise.test(draft)) {
    return { ok: false, reason: `${label}: promises work the source does not` };
  }
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
  const inPlace = slots.inPlace ?? [];
  const reworded = slots.reworded ?? [];
  if (slots.missing?.length) {
    const label = { prefix: "opening notice", suffix: "closing notice" };
    notes.push(`banner: the review did not carry its ${slots.missing.map((slot) => label[slot] ?? slot).join(" and ")}; the configured notice was added in its place`);
  }

  let bodyText = cite(proposal.body ?? "");
  for (const slot of inPlace) {
    if (!reworded.includes(slot)) continue;
    const text = (slots[slot] ?? "").trim();
    if (text) bodyText = replaceRegion(bodyText, slot, text);
  }

  const body = assembleBody({
    // A slot whose notice the review already wrote is never prepended as well; that is how a disclosure
    // ended up in the body twice, in two sets of words.
    prefix: slots.supplied.includes("prefix") && !inPlace.includes("prefix") ? slots.prefix : "",
    body: bodyText,
    verdictLine,
    suffix: slots.supplied.includes("suffix") && !inPlace.includes("suffix") ? slots.suffix : "",
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
