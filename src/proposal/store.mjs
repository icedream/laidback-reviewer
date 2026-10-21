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
  // A column added after the first release: exec() above is a no-op on an existing database.
  try {
    db.exec("ALTER TABLE gates ADD COLUMN slack_ts TEXT");
  } catch {
    // the column is already there
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
    findSeen: db.prepare(`SELECT * FROM seen WHERE owner = @owner AND repo = @repo AND pr = @pr AND head_sha = @head_sha`),
    markSeen: db.prepare(
      `INSERT OR REPLACE INTO seen (owner, repo, pr, head_sha, checked_at) VALUES (@owner, @repo, @pr, @head_sha, @now)`,
    ),
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

    /** Persist one composed review plus its comments. Returns the review row id. */
    saveReview({ owner, repo, pr, head_sha, composed, dryRun, notes = [] }) {
      const id = randomUUID();
      statements.insertReview.run({
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
      });
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
