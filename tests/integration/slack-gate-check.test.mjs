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
import { openStore } from "../../src/proposal/store.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");

function tempEnv(slackOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-gatecheck-"));
  const tree = baseConfig({ dir });
  tree.gate = {
    ...tree.gate,
    channel: "slack",
    slack: { ...tree.gate.slack, tokenEnv: "GATECHECK_XOXC", cookieEnv: "GATECHECK_XOXD", ...slackOverrides },
  };
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, stringify(tree));
  return { dir, config: file, db: path.join(dir, "gate-check.db") };
}

/** Answers only the four calls the gate makes, and replies to its own posts. */
function fakeSlack({ approver = "U_ME" } = {}) {
  const posts = [];
  const seen = [];
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
      const ts = "1700000000.000100";
      posts.push({ ...body, ts });
      return json({ ok: true, ts, channel: body.channel });
    }
    if (url.startsWith("/conversations.replies")) {
      const params = new URL(url, "http://localhost").searchParams;
      const post = posts.find((entry) => entry.ts === params.get("ts"));
      seen.push(params.get("ts"));
      const messages = [{ text: post?.text ?? "", user: "U_BOT", ts: post?.ts }];
      const requested = post ? /approve (\S+)/.exec(post.text)?.[1] : null;
      if (requested) messages.push({ text: `approve ${requested}`, user: approver, ts: "1700000000.000200" });
      return json({ ok: true, messages });
    }
    return json({ ok: false, error: "unknown_method" });
  });

  return {
    posts,
    seen,
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
      env: {
        ...process.env,
        LAIDBACK_CONFIG: config,
        LAIDBACK_GATE_CHECK_DB: db,
        LAIDBACK_SLACK_USERS: allowUsers,
        GATECHECK_XOXC: "xoxc-test",
        GATECHECK_XOXD: "xoxd-test",
      },
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
    env: { ...process.env, LAIDBACK_CONFIG: config, LAIDBACK_GATE_CHECK_DB: db, GATECHECK_XOXC: "", GATECHECK_XOXD: "", LAIDBACK_SLACK_USERS: "U_ME" },
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
