/**
 * Near-duplicate findings.
 *
 * The same issue worded twice reaches GitHub twice and reads as padding. An exact-string check only stops
 * a verbatim repeat, and a model that re-drafts a finding it already proposed produces a near match: same
 * file, same line, most of the same words.
 */

function shingles(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./:-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 <= words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out.size ? out : new Set(words);
}

export function similarity(a, b) {
  const firstShards = shingles(a);
  const secondShards = shingles(b);
  const firstWords = words(a);
  const secondWords = words(b);
  const phrase = overlap(firstShards, secondShards);
  const vocabulary = overlap(firstWords, secondWords);
  // Phrase overlap alone misses a re-drafted finding: three measured sarama comments scored 0.35 to 0.62
  // on shared trigrams but 0.55 to 0.70 on shared words, while unrelated findings stayed under 0.19.
  return Math.max(phrase, vocabulary * 0.7);
}

function words(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_./:-]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/** Line ranges that touch. Adjacent lines are different sites, so there is no slack here. */
export function rangesOverlap(a, b) {
  const aStart = a.start_line ?? a.line;
  const aEnd = a.line;
  const bStart = b.start_line ?? b.line;
  const bEnd = b.line;
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * @param queued the comments already collected
 * @param candidate the comment being proposed
 * @param threshold how much wording has to match before it counts as the same finding
 * @returns the earlier comment this duplicates, or null
 */
export function nearDuplicate(queued, candidate, { threshold = 0.35 } = {}) {
  return (
    queued.find(
      (existing) =>
        existing.path === candidate.path && rangesOverlap(existing, candidate) && similarity(existing.body, candidate.body) >= threshold,
    ) ?? null
  );
}
