/**
 * Citation form at compose time.
 *
 * A bare permalink inside a sentence renders as a code-preview card wedged into the text, and two of them
 * on one line render as two. A plain `path:line` mention of a file this PR touches is a missed link. Both
 * are mechanical to fix, and doing it here means the gate, the artifact and GitHub all show the same text.
 */

const PERMALINK = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[0-9a-f]{7,40}\/[^\s)#]+(?:#L\d+(?:-L\d+)?)/g;
const PLAIN_REF = /(?<![\w/.-])([A-Za-z0-9_./-]+\.(?:go|mod|sum|yml|yaml|json|sql|md|toml|sh|tf)):(?:L)?(\d+)(?:-(\d+))?(?![\w/-])/g;
const CODE_SPAN = /`[^`]*`/g;

function altFor(url) {
  const match = /\/blob\/[0-9a-f]{7,40}\/([^\s)#]+)(?:#L(\d+)(?:-L(\d+))?)?/.exec(url);
  if (!match) return null;
  const [, file, from, to] = match;
  return from ? `${file}:${from}${to ? `-${to}` : ""}` : file;
}

/** Inline links get alt text; a permalink that stands alone on its line keeps the preview. */
function inlineBarePermalinks(line) {
  const found = [...line.matchAll(PERMALINK)].filter((match) => line[match.index - 1] !== "(");
  if (!found.length) return { text: line, inlined: 0 };
  const isSolo = found.length === 1 && line.replace(found[0][0], "").trim() === "";
  if (isSolo) return { text: line, inlined: 0 };
  let inlined = 0;
  const text = found.reduce((acc, match) => {
    const alt = altFor(match[0]);
    if (!alt) return acc;
    inlined += 1;
    return acc.replace(match[0], `[${alt}](${match[0]})`);
  }, line);
  return { text, inlined };
}

/** Pin a plain mention of a file this PR touches to the head the review ran against. */
function pinPlainRefs(line, { owner, repo, headSha, knownPaths }) {
  if (!knownPaths?.size) return { text: line, pinned: 0 };
  const spans = [...line.matchAll(CODE_SPAN)].map((match) => match[0]);
  let pinned = 0;
  const text = line.replace(PLAIN_REF, (whole, file, from, to, offset) => {
    if (spans.some((span) => span.includes(whole))) return whole;
    if (!knownPaths.has(file)) return whole;
    // Inside a markdown link label the text is already reachable.
    if (line[offset - 1] === "[" || line.slice(0, offset).includes("](")) return whole;
    pinned += 1;
    const range = `#L${from}${to ? `-L${to}` : ""}`;
    return `[${file}:${from}${to ? `-${to}` : ""}](https://github.com/${owner}/${repo}/blob/${headSha}/${file}${range})`;
  });
  return { text, pinned };
}

/**
 * @param text the body or comment as the model wrote it
 * @param owner repo owner of the pull request
 * @param repo repository name
 * @param headSha the head the review was composed against
 * @param knownPaths paths this PR touches, the only plain mentions worth pinning
 * @returns {{ text: string, inlined: number, pinned: number }}
 */
export function normaliseCitations(text, { owner, repo, headSha, knownPaths }) {
  let inlined = 0;
  let pinned = 0;
  let inFence = false;
  const out = String(text ?? "")
    .split("\n")
    .map((line) => {
      // A suggestion fence is code the author pastes, not prose to reformat.
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      const bare = inlineBarePermalinks(line);
      const pinnedLine = pinPlainRefs(bare.text, { owner, repo, headSha, knownPaths });
      inlined += bare.inlined;
      pinned += pinnedLine.pinned;
      return pinnedLine.text;
    })
    .join("\n");
  return { text: out, inlined, pinned };
}
