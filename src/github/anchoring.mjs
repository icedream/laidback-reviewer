/**
 * Diff anchoring.
 *
 * GitHub accepts an inline review comment only on a line that appears in that file's diff, and a
 * range comment only when both ends sit in one hunk. `GET /pulls/N/files` is the only trustworthy
 * source of that: `git diff -U0` disagrees on rename-detected files, where unchanged lines carry no
 * hunk. So anchoring is derived from the API's own `patch` text.
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one file's `patch` into hunks with absolute old/new line numbers. */
export function parsePatch(patch) {
  if (!patch) return [];
  const hunks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of String(patch).split("\n")) {
    const header = HUNK_RE.exec(raw);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (marker === " ") {
      current.lines.push({ type: "ctx", oldLine: oldLine++, newLine: newLine++ });
    } else if (marker === "+") {
      current.lines.push({ type: "add", newLine: newLine++ });
    } else if (marker === "-") {
      current.lines.push({ type: "del", oldLine: oldLine++ });
    }
    // "\\ No newline at end of file" and anything else carry no line number.
  }
  return hunks;
}

/**
 * Commentable RIGHT-side line numbers per hunk, as contiguous runs.
 * A run is [{from, to, hunkIndex}] ordered by `from`.
 */
export function commentableRuns(patch) {
  const runs = [];
  parsePatch(patch).forEach((hunk, hunkIndex) => {
    let open = null;
    for (const line of hunk.lines) {
      if (line.type === "del") continue; // LEFT side only, not commentable on RIGHT
      if (open && line.newLine === open.to + 1) {
        open.to = line.newLine;
        continue;
      }
      open = { from: line.newLine, to: line.newLine, hunkIndex };
      runs.push(open);
    }
  });
  return runs;
}

function findFile(files, path) {
  const wanted = String(path || "").trim();
  const exact = files.find((f) => f.filename === wanted);
  if (exact) return exact;
  const byPrevious = files.find((f) => f.previous_filename === wanted);
  if (byPrevious) return byPrevious;
  const normalized = wanted.replace(/^\.\//, "");
  return files.find((f) => f.filename === normalized) ?? null;
}

function withinRun(runs, line) {
  return runs.find((run) => line >= run.from && line <= run.to) ?? null;
}

function nearestRun(runs, line) {
  let best = null;
  let bestDistance = Infinity;
  for (const run of runs) {
    const distance = line < run.from ? run.from - line : line > run.to ? line - run.to : 0;
    if (distance < bestDistance) {
      best = run;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Anchor one proposed comment.
 *
 * Returns { status: "ok" | "adjusted" | "dropped", comment, note }.
 * `comment` is ready for the reviews API: path, side, start_side, line, and start_line only when
 * the range survived. Notes are kept for the local artifact, never shown to the author as a new
 * finding.
 */
export function anchorComment(proposed, files) {
  const file = findFile(files, proposed.path);
  if (!file) {
    return { status: "dropped", note: `path not in diff: ${proposed.path}` };
  }
  if (!file.patch) {
    return { status: "dropped", note: `no patch for ${file.filename} (${file.status ?? "unchanged"})` };
  }

  const runs = commentableRuns(file.patch);
  if (!runs.length) {
    return { status: "dropped", note: `no RIGHT-side lines in ${file.filename}` };
  }

  const requestedEnd = proposed.line;
  const requestedStart = proposed.start_line ?? proposed.line;
  if (!Number.isInteger(requestedEnd) || requestedEnd < 1) {
    return { status: "dropped", note: `invalid line for ${file.filename}: ${proposed.line}` };
  }
  if (requestedStart > requestedEnd) {
    return { status: "dropped", note: `start_line ${requestedStart} after line ${requestedEnd} in ${file.filename}` };
  }

  const comment = {
    path: file.filename,
    side: "RIGHT",
    body: proposed.body,
  };

  if (requestedStart === requestedEnd) {
    const run = withinRun(runs, requestedEnd);
    if (run) {
      comment.line = requestedEnd;
      return { status: "ok", comment };
    }
    const near = nearestRun(runs, requestedEnd);
    comment.line = Math.min(Math.max(requestedEnd, near.from), near.to);
    return {
      status: "adjusted",
      comment,
      note: `${file.filename}:${requestedEnd} is not in the diff, anchored to ${comment.line}`,
    };
  }

  const startRun = withinRun(runs, requestedStart);
  const endRun = withinRun(runs, requestedEnd);
  if (startRun && endRun && startRun.hunkIndex === endRun.hunkIndex) {
    comment.start_line = requestedStart;
    comment.start_side = "RIGHT";
    comment.line = requestedEnd;
    return { status: "ok", comment };
  }

  // The span is not fully commentable, or crosses hunks. Keep the commentable part nearest the end
  // the reviewer pointed at, so the surviving comment still sits where they said the issue was.
  const overlaps = runs.filter((run) => run.to >= requestedStart && run.from <= requestedEnd);
  if (overlaps.length === 0) {
    const near = nearestRun(runs, requestedEnd);
    comment.line = Math.min(Math.max(requestedEnd, near.from), near.to);
    return {
      status: "adjusted",
      comment,
      note: `${file.filename}:${requestedStart}-${requestedEnd} is outside the diff, anchored to ${comment.line}`,
    };
  }

  const chosen = overlaps.filter((run) => run.from <= requestedEnd).pop() ?? overlaps[0];
  comment.start_line = Math.max(chosen.from, requestedStart);
  comment.start_side = "RIGHT";
  comment.line = Math.min(chosen.to, requestedEnd);
  if (comment.start_line === comment.line) delete comment.start_line;
  return {
    status: "adjusted",
    comment,
    note: `${file.filename}:${requestedStart}-${requestedEnd} spans uncommitted lines, narrowed to ${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}`,
  };
}

/** Line numbers GitHub would accept for one file, for prompts and tests. */
export function commentableLines(file) {
  return commentableRuns(file.patch).flatMap((run) => {
    const lines = [];
    for (let line = run.from; line <= run.to; line += 1) lines.push(line);
    return lines;
  });
}
