/**
 * The Slack gate check end to end, against a stand-in Slack.
 *
 * Authenticate, find the channel, post the gate message, read the `approve <id>` reply out of the
 * thread, and apply it only if the author is allowlisted.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { loadConfig } from "../../src/config.mjs";
import { createGate, renderGateSummary } from "../../src/gate/gate.mjs";
import { createSlackGate } from "../../src/gate/slack.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

/**
 * Child env kept minimal on purpose. An ambient LAIDBACK_SLACK_CHANNEL, token or model setting from the
 * host shell or from docker-compose would decide which channel and which credential the CLI under test
 * believes it is using, and the suite would pass or fail depending on where it was started.
 */
const AMBIENT_KEEP = new Set(["PATH", "HOME", "NODE_OPTIONS", "TZ", "LANG"]);

function childEnv(overrides) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => AMBIENT_KEEP.has(key)));
  return { ...base, ...overrides };
}

const ROOT = path.join(import.meta.dirname, "..", "..");

function tempEnv(slackOverrides = {}, { dryRun = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-gatecheck-"));
  const tree = baseConfig({ dir });
  tree.reviews.dryRun = dryRun;
  tree.gate = {
    ...tree.gate,
    channel: "slack",
    slack: { ...tree.gate.slack, tokenEnv: "GATECHECK_XOXC", cookieEnv: "GATECHECK_XOXD", ...slackOverrides },
  };
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, stringify(tree));
  return { dir, config: file, db: path.join(dir, "gate-check.db") };
}

/** Answers the calls the gate makes, and can answer with a reaction instead of a reply. */
function fakeSlack({ approver = "U_ME", textReply = true, react = null } = {}) {
  const posts = [];
  const marks = [];
  // What the channel's newest message was before this gate: putting the read marker back to it is
  // what makes a self-posted gate show as unread.
  const previousTs = "1700000000.000100";
  const reactions = [];
  const seen = [];
  let posted = 0;
  const nextTs = () => `1700000000.00${String(++posted).padStart(3, "0")}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = req.url;
    const json = (payload) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.startsWith("/auth.test")) return json({ ok: true, user: "gateowner", user_id: "U_ME", team: "Example" });
    if (url.startsWith("/conversations.list?types=im")) return json({ ok: true, channels: [{ id: "D_SELF", user: "U_ME" }] });
    if (url.startsWith("/conversations.list")) return json({ ok: true, channels: [] });
    if (url.startsWith("/chat.postMessage")) {
      const ts = nextTs();
      posts.push({ ...body, ts });
      return json({ ok: true, ts, channel: body.channel });
    }
    if (url.startsWith("/conversations.history")) return json({ ok: true, messages: [{ ts: previousTs, user: "U_ME" }] });
    if (url.startsWith("/conversations.mark")) {
      marks.push(body);
      return json({ ok: true });
    }
    if (url.startsWith("/reactions.add")) {
      reactions.push(body);
      return json({ ok: true });
    }
    if (url.startsWith("/conversations.replies")) {
      const params = new URL(url, "http://localhost").searchParams;
      const rootTs = params.get("ts");
      const post = posts.find((entry) => entry.ts === rootTs);
      seen.push(rootTs);
      const root = { text: post?.text ?? "", user: "U_BOT", ts: rootTs };
      if (react) root.reactions = [{ name: react.name, count: 1, users: [react.user] }];
      const messages = [root];
      // Thread replies from the gate itself carry the poster's identity, the same one that may decide.
      for (const entry of posts) if (entry.thread_ts === rootTs) messages.push({ text: entry.text, user: entry.user ?? "U_ME", ts: entry.ts });
      const requested = post ? /approve (\S+)/.exec(post.text)?.[1] : null;
      if (requested && textReply) messages.push({ text: `approve ${requested}`, user: approver, ts: nextTs() });
      return json({ ok: true, messages });
    }
    return json({ ok: false, error: "unknown_method" });
  });

  return {
    posts,
    marks,
    reactions,
    seen,
    previousTs,
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/**
 * The child posts to a server running in this process, so it must not be spawned synchronously:
 * spawnSync blocks the event loop and the fake Slack can never answer.
 */
function runCheck({ config, db, allowUsers, timeout = "4" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/gate-check.mjs", "--timeout", timeout], {
      cwd: ROOT,
      env: childEnv({
        LAIDBACK_CONFIG: config,
        LAIDBACK_GATE_CHECK_DB: db,
        LAIDBACK_SLACK_USERS: allowUsers,
        GATECHECK_XOXC: "xoxc-test",
        GATECHECK_XOXD: "xoxd-test",
      }),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("post, read the thread, and apply the approval", async () => {
  const slack = fakeSlack();
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_ME" });

    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /auth: gateowner in Example/);
    assert.match(run.stdout, /channel: D_SELF/, "the self DM is found through conversations.list");
    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0].text, /laidback-reviewer gate [0-9a-f-]{8}/);
    assert.match(run.stdout, /decision read: approved by U_ME/);
    assert.match(run.stdout, /reading works/);

    // The row is written where the real loop would see it.
    const store = openStore(db);
    try {
      const gates = store.pendingGates();
      assert.deepEqual(gates, [], "the gate is no longer pending");
    } finally {
      store.close();
    }
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reaction on the gate message decides it, with no text reply", async () => {
  const slack = fakeSlack({ textReply: false, react: { name: "white_check_mark", user: "U_ME" } });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_ME" });

    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /decision read: approved by U_ME/);
    assert.match(slack.posts[0].text, /React :white_check_mark: approve, :x: reject, :hourglass_flowing_sand: hold/);
    assert.deepEqual(slack.reactions, [], "the poster is U_ME, so seeding would make the click remove it");
    assert.match(run.stdout, /not seeding its own reactions/);
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the reactions are seeded when the deciders are not the posting user", async () => {
  const slack = fakeSlack({ textReply: false, react: { name: "white_check_mark", user: "U_OTHER" } });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_OTHER" });

    assert.match(run.stdout, /decision read: approved by U_OTHER/);
    assert.deepEqual(
      slack.reactions.map((entry) => entry.name),
      ["white_check_mark", "x", "hourglass_flowing_sand"],
      "a second hand can click a chip that is already there",
    );
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reject reaction records a rejection and its reason", async () => {
  const slack = fakeSlack({ textReply: false, react: { name: "x", user: "U_ME" } });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_ME" });

    assert.match(run.stdout, /decision read: rejected by U_ME \(reacted x\)/);
    assert.equal(run.status, 2, "only an approval exits 0");
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reaction from someone off the allowlist is ignored", async () => {
  const slack = fakeSlack({ textReply: false, react: { name: "white_check_mark", user: "U_STRANGER" } });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_ME", timeout: "1" });

    assert.equal(slack.posts.length, 1);
    assert.match(run.stdout, /no decision within/);
    assert.equal(run.status, 2);
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an approval from someone off the allowlist is ignored", async () => {
  const slack = fakeSlack({ approver: "U_STRANGER" });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "U_ME", timeout: "1" });

    assert.equal(slack.posts.length, 1, "the message still went out");
    assert.match(run.stdout, /no decision within/);
    assert.equal(run.status, 2);
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty allowlist is warned about rather than silently allowing anyone", async () => {
  const slack = fakeSlack({ approver: "U_ANYONE" });
  const apiBaseUrl = await slack.start();
  const { dir, config, db } = tempEnv({ apiBaseUrl });
  try {
    const run = await runCheck({ config, db, allowUsers: "", timeout: "1" });
    assert.match(run.stdout, /any member of the gate channel can approve/);
    // With no allowlist the reply is accepted, which is exactly why the warning exists.
    assert.match(run.stdout, /decision read: approved by U_ANYONE/);
  } finally {
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing token says which variable and what to copy into it", () => {
  const { dir, config, db } = tempEnv();
  const run = spawnSync(process.execPath, ["src/cli/gate-check.mjs"], {
    cwd: ROOT,
    env: childEnv({ LAIDBACK_CONFIG: config, LAIDBACK_GATE_CHECK_DB: db, GATECHECK_XOXC: "", GATECHECK_XOXD: "", LAIDBACK_SLACK_USERS: "U_ME" }),
    encoding: "utf8",
    timeout: 20_000,
  });
  try {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /GATECHECK_XOXC is unset/);
    assert.match(run.stderr, /xoxc-\.\.\./);
    assert.match(run.stderr, /transport=botToken/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every inline comment is posted in the thread, and none of them decides the gate", async () => {
  const slack = fakeSlack({ textReply: false });
  const apiBaseUrl = await slack.start();
  const { dir, config } = tempEnv({ apiBaseUrl }, { dryRun: false });
  const env = childEnv({ GATECHECK_XOXC: "xoxc-test", GATECHECK_XOXD: "xoxd-test", LAIDBACK_SLACK_USERS: "U_ME" });
  const cfg = loadConfig({ path: config, env });
  const store = openStore(path.join(dir, "comments.db"));
  try {
    const composed = {
      verdict: "request_changes",
      action: "submit",
      event: "REQUEST_CHANGES",
      payload: {
        body: "one thing blocks this",
        comments: [
          { path: "go.mod", line: 119, body: "the pin is below main, which already carries x/net 0.60" },
          { path: "internal/server/server.go", start_line: 40, line: 44, body: "no test for the customer id filter the ticket asks for" },
        ],
      },
      proposalBody: "",
      proposalBlocking: [],
    };
    const reviewId = store.saveReview({ owner: "acme", repo: "svc", pr: 7, head_sha: "abcdef0123456789", composed, dryRun: false, notes: [] });
    const slackGate = createSlackGate({ cfg, store, token: "xoxc-test", cookie: "xoxd-test", log: () => {} });
    const gate = createGate({ cfg, store, slack: slackGate, log: () => {} });
    const opened = await gate.open({
      stage: "before_post",
      reviewId,
      summary: renderGateSummary({
        pr: { html_url: "https://github.com/acme/svc/pull/7" },
        headSha: "abcdef0123456789",
        composed,
        notes: [],
        decisions: ["verdict request_changes -> submit"],
      }),
    });

    const [root, ...replies] = slack.posts;
    assert.equal(replies.length, 2, "one reply per inline comment");
    assert.ok(replies.every((entry) => entry.thread_ts === root.ts), "replies stay in the gate thread");
    assert.match(replies[0].text, /^go\.mod:119\n/);
    assert.match(replies[1].text, /^internal\/server\/server\.go:40-44\n/);
    assert.match(replies[1].text, /no test for the customer id filter/);
    assert.match(root.text, /go\.mod:119 .* the pin is below main/, "the summary names what sits at the position");

    const row = store.pendingGates().find((entry) => entry.id === opened.gateId);
    assert.deepEqual(JSON.parse(row.comment_ts), replies.map((entry) => entry.ts));

    // A gate you posted to yourself is read the instant it lands, so the marker goes back: that is what
    // makes it show as unread in the client.
    assert.deepEqual(slack.marks, [{ channel: "D_SELF", ts: slack.previousTs }], "auto puts the read marker back in a self-DM");

    // Those replies carry the same identity as the decider, so the recorded ts list is what keeps a
    // decision-shaped one from deciding anything.
    slack.posts[1].text = `approve ${opened.gateId} decided by accident`;
    const applied = await slackGate.readDecisions();
    assert.deepEqual(applied, [], "the gate's own replies are not decisions");
    assert.equal(store.pendingGates().find((entry) => entry.id === opened.gateId).state, "pending");
  } finally {
    store.close();
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Run a CLI in a child while the fake Slack answers from this process. */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("gate.mjs sync reads a Slack decision into the store, which is what post-approved needs", async () => {
  const slack = fakeSlack();
  const apiBaseUrl = await slack.start();
  const { dir, config } = tempEnv({ apiBaseUrl }, { dryRun: false });
  const db = path.join(dir, "sync.db");
  const env = childEnv({ LAIDBACK_CONFIG: config, LAIDBACK_STATE_DB: db, LAIDBACK_SLACK_USERS: "U_ME", GATECHECK_XOXC: "xoxc-test", GATECHECK_XOXD: "xoxd-test" });
  const cfg = loadConfig({ path: config, env });
  const store = openStore(db);
  try {
    const composed = {
      verdict: "request_changes",
      action: "submit",
      event: "REQUEST_CHANGES",
      payload: { body: "one thing blocks this", comments: [] },
      proposalBody: "",
      proposalBlocking: [],
    };
    const reviewId = store.saveReview({ owner: "acme", repo: "svc", pr: 9, head_sha: "abc1234567890", composed, dryRun: false, notes: [] });
    const gate = createGate({
      cfg,
      store,
      slack: createSlackGate({ cfg, store, token: "xoxc-test", cookie: "xoxd-test", log: () => {} }),
      log: () => {},
    });
    const opened = await gate.open({
      stage: "before_post",
      reviewId,
      summary: renderGateSummary({ pr: { html_url: "https://github.com/acme/svc/pull/9" }, headSha: "abc1234567890", composed, notes: [], decisions: ["verdict request_changes -> submit"] }),
    });
    assert.equal(store.getGate(opened.gateId).state, "pending", "the decision is in Slack, not in the store yet");

    const run = await runCli(["src/cli/gate.mjs", "sync"], env);

    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`gate ${opened.gateId} -> approved by U_ME`));
    assert.equal(store.getGate(opened.gateId).state, "approved");
    assert.deepEqual(store.approvedUnpostedReviews(), [reviewId], "post-approved now has something to send");
  } finally {
    store.close();
    slack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the read marker is put back only where a self-posted gate would go unnoticed", async () => {
  const cases = [
    { slackOverrides: {}, allowUsers: "U_ME", expectMark: true, why: "auto: the poster is a decider" },
    { slackOverrides: {}, allowUsers: "U_OTHER", expectMark: false, why: "auto: the poster cannot decide" },
    { slackOverrides: { markUnread: "never" }, allowUsers: "U_ME", expectMark: false, why: "never: leave the client alone" },
    { slackOverrides: { markUnread: "always" }, allowUsers: "U_OTHER", expectMark: true, why: "always: mark even when the poster cannot decide" },
  ];

  for (const testCase of cases) {
    const slack = fakeSlack();
    const apiBaseUrl = await slack.start();
    const { dir, config } = tempEnv({ apiBaseUrl, ...testCase.slackOverrides }, { dryRun: false });
    const cfg = loadConfig({ path: config, env: { GATECHECK_XOXC: "xoxc-test", GATECHECK_XOXD: "xoxd-test", LAIDBACK_SLACK_USERS: testCase.allowUsers } });
    const store = openStore(path.join(dir, "mark.db"));
    try {
      const gate = createGate({
        cfg,
        store,
        slack: createSlackGate({ cfg, store, token: "xoxc-test", cookie: "xoxd-test", log: () => {} }),
        log: () => {},
      });
      await gate.open({
        stage: "before_post",
        reviewId: null,
        summary: `verdict request_changes: gate ${testCase.why}`,
      });

      if (testCase.expectMark) {
        assert.deepEqual(slack.marks, [{ channel: "D_SELF", ts: slack.previousTs }], testCase.why);
      } else {
        assert.deepEqual(slack.marks, [], testCase.why);
      }
      assert.ok(slack.posts.length, "the gate message itself still went out in every case");
    } finally {
      store.close();
      slack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
