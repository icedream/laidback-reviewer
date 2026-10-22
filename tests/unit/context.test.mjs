/**
 * Which earlier look gets carried into a new review run.
 *
 * The picker is pure over a store and a PR view, so the interesting cases (stack sibling, ticket in
 * common, changed-file overlap below the floor) are here rather than behind a full session.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../../src/proposal/store.mjs";
import { pickContext } from "../../src/context/carried-over.mjs";
import { resolveStack } from "../../src/context/stack.mjs";

const contextCfg = (overrides = {}) => ({
  context: { enabled: true, maxAgeDays: 30, minScore: 35, allowCrossRepo: false, sessionDir: "", mode: "auto", maxForkTokens: 48000, ...overrides },
});

const prView = (overrides = {}) => ({
  number: 143,
  owner: "example",
  repo: "orders-svc",
  title: "refactor: move order listing behind a service client",
  body: "Implements ORD-142.",
  head: { ref: "ORD-142/pagination", sha: "b".repeat(40) },
  base: { ref: "main", sha: "a".repeat(40) },
  ...overrides,
});

function seed(store, { pr, headSha, comments = [], branch = null, sessionFile = null, verdict = "request_changes", action = "hint", body = "", repo = "orders-svc" }) {
  const id = store.saveReview({
    owner: "example",
    repo,
    pr,
    head_sha: headSha,
    composed: { verdict, action, event: "COMMENT", payload: { body, comments }, proposalBody: body, proposalBlocking: [] },
    dryRun: true,
    notes: [],
  });
  for (const comment of comments) store.db.prepare(`INSERT INTO comments (review_id, path, line, body) VALUES (?, ?, ?, ?)`).run(id, comment.path, comment.line, comment.body);
  store.setSession({ id, sessionFile, branch, stackKey: `example/orders-svc#${pr}` });
  return id;
}

test("a PR stacked on another PR reports the chain and its siblings", async () => {
  const pulls = {
    "feature/first-step": { number: 142, title: "add pagination helpers", head: { ref: "feature/first-step", sha: "c".repeat(40) }, base: { ref: "main", sha: "a".repeat(40) } },
  };
  const asked = [];
  const client = {
    listPullsForHead: async (_owner, _repo, branch) => {
      asked.push(branch);
      return pulls[branch] ? [pulls[branch]] : [];
    },
  };
  const pr = prView({ base: { ref: "feature/first-step", sha: "a".repeat(40) } });

  const stack = await resolveStack({ client, owner: "example", repo: "orders-svc", pr, defaultBranch: "main" });
  assert.deepEqual(stack.chain.map((entry) => entry.number), [143, 142]);
  assert.deepEqual(stack.siblings, [142]);
  assert.equal(stack.key, "example/orders-svc#142");
  assert.deepEqual(asked, ["feature/first-step"]);
});

test("a PR based straight on trunk has no stack, and no API call is made", async () => {
  let calls = 0;
  const client = {
    listPullsForHead: async () => {
      calls += 1;
      return [];
    },
  };
  const stack = await resolveStack({ client, owner: "example", repo: "orders-svc", pr: prView(), defaultBranch: "main" });
  assert.deepEqual(stack.siblings, []);
  assert.equal(calls, 0);
});

test("the same PR at an earlier head outranks a stack sibling", () => {
  const store = openStore(":memory:");
  try {
    seed(store, { pr: 142, headSha: "d".repeat(40), comments: [{ path: "internal/api/pagination.go", line: 21, body: "Offset skips the first page." }] });
    seed(store, { pr: 143, headSha: "c".repeat(40), comments: [{ path: "internal/service/orders.go", line: 79, body: "The decode error is dropped." }] });

    const picked = pickContext({
      cfg: contextCfg({ mode: "digest" }),
      store,
      pr: prView(),
      stack: { key: "k", chain: [], siblings: [142] },
      files: [{ filename: "internal/api/pagination.go" }, { filename: "internal/service/orders.go" }],
    });

    assert.equal(picked.matched, true);
    assert.equal(picked.kind, "same_pr");
    assert.equal(picked.mode, "digest");
    assert.match(picked.description, /the same PR at an earlier head, PR #143/);
    assert.match(picked.instructions, /internal\/service\/orders\.go:79: The decode error is dropped\./);
    assert.match(picked.instructions, /Check each point against the current head/);
  } finally {
    store.close();
  }
});

test("a small session file forks, and a large one falls back to the digest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-context-"));
  const store = openStore(":memory:");
  try {
    const small = path.join(dir, "small.jsonl");
    fs.writeFileSync(small, JSON.stringify({ type: "message" }).repeat(40));
    const big = path.join(dir, "big.jsonl");
    fs.writeFileSync(big, "x".repeat(400_000));

    seed(store, { pr: 143, headSha: "c".repeat(40), sessionFile: small, comments: [{ path: "a.go", line: 1, body: "first" }] });
    const forked = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(forked.mode, "fork");
    assert.match(forked.instructions, /That earlier session is in your conversation/);

    store.db.prepare("UPDATE reviews SET session_file = ?").run(big);
    const digested = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(digested.mode, "digest");
    assert.match(digested.instructions, /a.go:1: first/);

    // An explicit digest setting never forks, however small the session is.
    seed(store, { pr: 145, headSha: "e".repeat(40), sessionFile: small, branch: prView().head.ref });
    const forced = pickContext({ cfg: contextCfg({ mode: "digest" }), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(forced.mode, "digest");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket in common beats file overlap, and weak overlap is refused", () => {
  const store = openStore(":memory:");
  try {
    seed(store, { pr: 150, headSha: "f".repeat(40), body: "Follow-up on ORD-142.", comments: [{ path: "docs/x.md", line: 3, body: "Stale sentence." }] });

    const byTicket = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "internal/api/pagination.go" }] });
    assert.equal(byTicket.kind, "same_ticket");
    assert.match(byTicket.description, /a PR sharing this ticket, PR #150/);

    // Same file, no ticket, no branch: overlap is the only signal, and it is below the floor here.
    seed(store, { pr: 151, headSha: "9".repeat(40), comments: [{ path: "unrelated/other.go", line: 1, body: "x" }] });
    const refused = pickContext({
      cfg: contextCfg({ minScore: 100 }),
      store,
      pr: prView({ body: "no ticket reference here", title: "refactor: something else", head: { ref: "feature/other", sha: "b".repeat(40) } }),
      stack: { siblings: [] },
      files: [{ filename: "internal/api/pagination.go" }, { filename: "internal/api/orders.go" }],
    });
    assert.equal(refused.matched, false);
    assert.match(refused.reason, /minScore=100/);
  } finally {
    store.close();
  }
});

test("cross-repo context follows a ticket, and only when it is allowed", () => {
  const store = openStore(":memory:");
  try {
    seed(store, {
      repo: "billing-svc",
      pr: 90,
      headSha: "1".repeat(40),
      body: "ORD-142 on the billing side.",
      comments: [{ path: "internal/limit.go", line: 12, body: "The cap is applied after the page slice." }],
    });

    const off = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(off.matched, false);

    const on = pickContext({ cfg: contextCfg({ allowCrossRepo: true }), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(on.matched, true);
    assert.equal(on.kind, "same_ticket");
    assert.equal(on.crossRepo, true);
    assert.match(on.description, /a PR sharing this ticket in example\/billing-svc, PR #90/);
    // Never a fork: the earlier session belongs to a different checkout.
    assert.equal(on.mode, "digest");
    assert.match(on.instructions, /internal\/limit\.go:12: The cap is applied after the page slice\./);
  } finally {
    store.close();
  }
});

test("nothing inside the window means a cold start, and the current head is never its own context", () => {
  const store = openStore(":memory:");
  try {
    const cold = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(cold.matched, false);
    assert.match(cold.reason, /no review of this repository/);

    // Same PR, same head: a re-request over the head that was already reviewed. Refusing this is how the
    // pass came back with the same findings twice.
    seed(store, { pr: 143, headSha: prView().head.sha, comments: [{ path: "a.go", line: 1, body: "the guard is missing" }] });
    const same = pickContext({ cfg: contextCfg(), store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(same.matched, true);
    assert.equal(same.kind, "same_head");
    assert.match(same.instructions, /a\.go:1: the guard is missing/);

    // context.enabled=false is honoured without touching the store.
    const off = pickContext({ cfg: { context: { enabled: false } }, store, pr: prView(), stack: { siblings: [] }, files: [{ filename: "a.go" }] });
    assert.equal(off.matched, false);
    assert.equal(off.reason, "context.enabled=false");
  } finally {
    store.close();
  }
});

test("a re-request over the same head carries what that head's earlier pass concluded", () => {
  const store = openStore(":memory:");
  try {
    const pr = prView();
    seed(store, {
      pr: pr.number,
      headSha: pr.head.sha,
      body: "The context leak in the stream handler is the blocker.",
      comments: [{ path: "internal/service/stream.go", line: 44, body: "The span is never ended on the error path." }],
    });

    const picked = pickContext({ cfg: contextCfg(), store, pr, stack: { siblings: [] }, files: [{ filename: "internal/service/stream.go" }] });

    assert.equal(picked.matched, true, "the earlier pass over this head is the best context there is");
    assert.equal(picked.kind, "same_head");
    assert.match(picked.description, /an earlier pass over this same head, PR #143/);
    assert.match(picked.instructions, /internal\/service\/stream\.go:44: The span is never ended on the error path\./);
    assert.match(picked.instructions, /context leak in the stream handler/);
  } finally {
    store.close();
  }
});
