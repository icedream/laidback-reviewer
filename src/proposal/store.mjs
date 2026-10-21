/**
 * State: what was reviewed, what was proposed, and what a human decided.
 *
 * Dedupe is by (owner, repo, pr, head_sha): a force push is a new review candidate, everything
 * else is already handled.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  verdict TEXT,
  action TEXT,
  event TEXT,
  body TEXT,
  proposed_body TEXT,
  blocking TEXT,
  dry_run INTEGER NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  github_review_id TEXT,
  html_url TEXT,
  artifact_path TEXT,
  session_file TEXT,
  branch TEXT,
  stack_key TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_unique ON reviews (owner, repo, pr, head_sha);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews (id),
  path TEXT NOT NULL,
  start_line INTEGER,
  line INTEGER NOT NULL,
  body TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  review_id TEXT REFERENCES reviews (id),
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  slack_ts TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS failures (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  next_try_at TEXT NOT NULL,
  parked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr, head_sha)
);

CREATE TABLE IF NOT EXISTS seen (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pr, head_sha)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openStore(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // Columns added after the first release: exec() above is a no-op on an existing database.
  for (const column of ["slack_ts TEXT"]) {
    try {
      db.exec(`ALTER TABLE gates ADD COLUMN ${column}`);
    } catch {
      // present already
    }
  }
  for (const column of ["session_file TEXT", "branch TEXT", "stack_key TEXT"]) {
    try {
      db.exec(`ALTER TABLE reviews ADD COLUMN ${column}`);
    } catch {
      // present already
    }
  }
  return createStore(db);
}

const now = () => new Date().toISOString();

export function createStore(db) {
  const statements = {
    insertReview: db.prepare(
      `INSERT INTO reviews (id, owner, repo, pr, head_sha, verdict, action, event, body, proposed_body, blocking, dry_run, notes, created_at, updated_at)
       VALUES (@id, @owner, @repo, @pr, @head_sha, @verdict, @action, @event, @body, @proposed_body, @blocking, @dry_run, @notes, @now, @now)`,
    ),
    insertComment: db.prepare(
      `INSERT INTO comments (review_id, path, start_line, line, body, note)
       VALUES (@review_id, @path, @start_line, @line, @body, @note)`,
    ),
    markPosted: db.prepare(
      `UPDATE reviews SET posted = 1, github_review_id = @github_review_id, html_url = @html_url, updated_at = @now
       WHERE id = @id`,
    ),
    setArtifact: db.prepare(`UPDATE reviews SET artifact_path = @path, updated_at = @now WHERE id = @id`),
    setSession: db.prepare(`UPDATE reviews SET session_file = @session_file, branch = @branch, stack_key = @stack_key, updated_at = @now WHERE id = @id`),
    recentReviews: db.prepare(
      `SELECT * FROM reviews
       WHERE created_at >= @since
         AND (@owner IS NULL OR (owner = @owner AND repo = @repo))
       ORDER BY created_at DESC LIMIT 50`,
    ),
    findSeen: db.prepare(`SELECT * FROM seen WHERE owner = @owner AND repo = @repo AND pr = @pr AND head_sha = @head_sha`),
    updateReview: db.prepare(
      `UPDATE reviews
       SET verdict = @verdict, action = @action, event = @event, body = @body, proposed_body = @proposed_body,
           blocking = @blocking, dry_run = @dry_run, notes = @notes, updated_at = @now
       WHERE id = @id`,
    ),
    deleteComments: db.prepare(`DELETE FROM comments WHERE review_id = @review_id`),
    markSeen: db.prepare(
      `INSERT OR REPLACE INTO seen (owner, repo, pr, head_sha, checked_at) VALUES (@owner, @repo, @pr, @head_sha, @now)`,
    ),
    getFailure: db.prepare(`SELECT * FROM failures WHERE owner = @owner AND repo = @repo AND pr = @pr AND head_sha = @head_sha`),
    upsertFailure: db.prepare(
      `INSERT INTO failures (owner, repo, pr, head_sha, attempts, last_error, next_try_at, parked, updated_at)
       VALUES (@owner, @repo, @pr, @head_sha, @attempts, @last_error, @next_try_at, @parked, @now)
       ON CONFLICT(owner, repo, pr, head_sha)
       DO UPDATE SET attempts = @attempts, last_error = @last_error, next_try_at = @next_try_at, parked = @parked, updated_at = @now`,
    ),
    clearFailure: db.prepare(`DELETE FROM failures WHERE owner = @owner AND repo = @repo AND pr = @pr AND head_sha = @head_sha`),
    listFailures: db.prepare(`SELECT * FROM failures ORDER BY updated_at DESC LIMIT 100`),
    getReview: db.prepare(`SELECT * FROM reviews WHERE id = @id`),
    reviewFor: db.prepare(`SELECT * FROM reviews WHERE owner = @owner AND repo = @repo AND pr = @pr AND head_sha = @head_sha`),
    commentsFor: db.prepare(`SELECT * FROM comments WHERE review_id = @review_id ORDER BY id`),
    openGate: db.prepare(
      `INSERT INTO gates (id, kind, review_id, state, summary, created_at) VALUES (@id, @kind, @review_id, 'pending', @summary, @now)`,
    ),
    getGate: db.prepare(`SELECT * FROM gates WHERE id = @id`),
    setSlackTs: db.prepare(`UPDATE gates SET slack_ts = @ts WHERE id = @id`),
    pendingGates: db.prepare(`SELECT * FROM gates WHERE state = 'pending' ORDER BY created_at`),
    decideGate: db.prepare(
      `UPDATE gates SET state = @state, decided_at = @now, decided_by = @decided_by, reason = @reason WHERE id = @id`,
    ),
    gatesForReview: db.prepare(`SELECT * FROM gates WHERE review_id = @review_id ORDER BY created_at`),
    getMeta: db.prepare(`SELECT value FROM meta WHERE key = @key`),
    setMeta: db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (@key, @value)`),
  };

  return {
    db,
    close: () => db.close(),

    alreadyHandled({ owner, repo, pr, head_sha }) {
      return !!statements.findSeen.get({ owner, repo, pr, head_sha });
    },
    markSeen({ owner, repo, pr, head_sha }) {
      statements.markSeen.run({ owner, repo, pr, head_sha, now: now() });
    },

    getFailure: (key) => statements.getFailure.get(key),
    recordFailure: (row) => statements.upsertFailure.run({ ...row, now: row.now ?? now() }),
    clearFailure: (key) => statements.clearFailure.run(key),
    listFailures: () => statements.listFailures.all(),

    /** Persist one composed review plus its comments. Returns the review row id. */
    saveReview({ owner, repo, pr, head_sha, composed, dryRun, notes = [] }) {
      // A row is identified by (pr, head_sha): a second attempt at the same head replaces the first,
      // and a moved head gets its own row.
      const existing = statements.reviewFor.get({ owner, repo, pr, head_sha });
      const id = existing?.id ?? randomUUID();
      if (existing) statements.deleteComments.run({ review_id: id });
      const fields = {
        id,
        owner,
        repo,
        pr,
        head_sha,
        // The model's verdict, not the mapped event: a hinted approval must not read as APPROVE here.
        verdict: composed.verdict,
        action: composed.action,
        event: composed.event,
        body: composed.payload.body,
        proposed_body: composed.proposalBody,
        blocking: JSON.stringify(composed.proposalBlocking ?? []),
        dry_run: dryRun ? 1 : 0,
        notes: JSON.stringify(notes),
        now: now(),
      };
      if (existing) statements.updateReview.run(fields);
      else statements.insertReview.run(fields);
      for (const comment of composed.payload.comments) {
        statements.insertComment.run({
          review_id: id,
          path: comment.path,
          start_line: comment.start_line ?? null,
          line: comment.line,
          body: comment.body,
          note: comment.note ?? null,
        });
      }
      return id;
    },

    getReview: (id) => statements.getReview.get({ id }),
    reviewFor: (key) => statements.reviewFor.get(key),
    commentsFor: (reviewId) => statements.commentsFor.all({ review_id: reviewId }),
    markPosted({ id, github_review_id, html_url }) {
      statements.markPosted.run({ id, github_review_id, html_url, now: now() });
    },
    setArtifact({ id, path }) {
      statements.setArtifact.run({ id, path, now: now() });
    },
    setSession({ id, sessionFile, branch, stackKey }) {
      statements.setSession.run({ id, session_file: sessionFile ?? null, branch: branch ?? null, stack_key: stackKey ?? null, now: now() });
    },
    /** Reviews inside the context window, newest first. Omit owner/repo for every repository. */
    recentReviews: ({ owner = null, repo = null, sinceIso }) =>
      statements.recentReviews.all({ owner, repo, since: sinceIso }),

    openGate({ kind, review_id = null, summary }) {
      const id = randomUUID().slice(0, 8);
      statements.openGate.run({ id, kind, review_id, summary, now: now() });
      return id;
    },
    getGate: (id) => statements.getGate.get({ id }),
    setSlackTs: ({ id, ts }) => statements.setSlackTs.run({ id, ts }),
    pendingGates: () => statements.pendingGates.all(),
    gatesForReview: (reviewId) => statements.gatesForReview.all({ review_id: reviewId }),
    /** Composed reviews whose gate an admin approved but which were never sent. */
    approvedUnpostedReviews: () =>
      db.prepare(`SELECT DISTINCT r.id FROM reviews r JOIN gates g ON g.review_id = r.id WHERE r.posted = 0 AND g.state = 'approved'`).all().map((row) => row.id),
    decideGate({ id, state, decided_by, reason = null }) {
      statements.decideGate.run({ id, state, decided_by, reason, now: now() });
      return statements.getGate.get({ id });
    },

    getMeta: (key) => statements.getMeta.get({ key })?.value ?? null,
    setMeta: (key, value) => statements.setMeta.run({ key, value }),
  };
}
