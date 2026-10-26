/**
 * A task gate whose pull request merged before the pass ran.
 *
 * Discovery searches open pull requests, so an approval tapped after a merge can never be consumed: the
 * head is not a candidate again, and the gate would sit `approved` with its message reading as a decision
 * waiting on a review that will never come. What is pinned here is that the gate settles instead, says why,
 * and spends no model time on merged code.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withdrawClosedPullGates } from "../../src/gate/obsolete.mjs";
import { createTelegramGate } from "../../src/gate/telegram.mjs";
import { taskGateSummary } from "../../src/review-run.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";
import { createTelegramFake } from "../fakes/telegram.mjs";

const MERGED_AT = "2026-04-03T11:10:00Z";

/** Merge the pull request the fake serves, which also takes it out of discovery's search. */
function mergePull({ github, at = MERGED_AT }) {
  const pr = github.pr();
  pr.state = "closed";
  pr.merged_at = at;
  pr.closed_at = at;
  return pr;
}

test("an approval tapped after the pull request merged settles the gate and runs nothing", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    const [queued] = env.store.pendingGates();
    assert.equal(queued.kind, "before_review:cli");
    env.store.decideGate({ id: queued.id, state: "approved", decided_by: "cli", reason: "" });

    mergePull({ github: env.github });
    await env.cycle();

    const gate = env.store.getGate(queued.id);
    assert.equal(gate.state, "withdrawn");
    assert.equal(gate.decided_by, "harness");
    assert.match(gate.reason, /pull request merged at 2026-04-03 11:10Z/);
    assert.equal(env.model.requests().length, 0, "no model time goes to code that is already in the base branch");
    assert.equal(env.github.postedReviews().length, 0);
    assert.match(env.log(), /gate .* withdrawn: pull request merged/);

    await env.cycle();
    assert.equal(env.store.getGate(queued.id).state, "withdrawn", "the next cycle does not put the ask back");
    assert.equal(env.store.pendingGates().length, 0);
  } finally {
    env.close();
  }
});

test("a task gate still waiting for a decision is withdrawn once the pull request is gone", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    const [queued] = env.store.pendingGates();
    mergePull({ github: env.github });

    await env.cycle();

    assert.deepEqual(env.store.pendingGates(), [], "nobody is asked to approve a review that cannot run");
    assert.match(env.store.getGate(queued.id).state, /^withdrawn$/);
  } finally {
    env.close();
  }
});

test("an open pull request keeps its task gate waiting", async () => {
  const env = await setupReviewRun({ overrides: { reviews: { dryRun: false }, gate: { channel: "cli", beforeReview: true, beforePost: false } } });
  try {
    await env.cycle();
    const [queued] = env.store.pendingGates();

    await env.cycle();
    await env.cycle();

    const gate = env.store.getGate(queued.id);
    assert.equal(gate.state, "pending", "the ask stands while the pull request is open");
    assert.equal(env.store.pendingGates().length, 1, "and it is still the one ask for this head");
    assert.equal(env.model.requests().length, 0);
  } finally {
    env.close();
  }
});

/** The sweep on its own, over a store and a channel, with the pull request state scripted per case. */
async function sweepFixture({ pull, throws = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-withdraw-"));
  const telegram = createTelegramFake();
  const apiBase = await telegram.start();
  const store = openStore(path.join(dir, "state.db"));
  const cfg = {
    reviews: { dryRun: false },
    gate: { channel: "telegram", beforeReview: true, beforePost: true, timeoutHours: 24, onTimeout: "hold", maxPending: 5, telegram: { timeoutMs: 5_000, longPollSeconds: 0, maxFindingButtons: 8, rerunButton: true, notify: true } },
  };
  const transport = createTelegramGate({ cfg, store, token: telegram.token, chatId: "4242", allowUsers: ["4242"], log: () => {}, apiBase });
  const target = { owner: "example", repo: "orders-svc", pr: 143, head_sha: "9c1f2be4d0a74a1e0c2e5f6a7b8c9d0e1f2a3b4c" };
  const summary = taskGateSummary({
    pr: { html_url: "https://github.com/example/orders-svc/pull/143", repository: "example/orders-svc", number: 143, title: "fix: page the order listing" },
    headSha: target.head_sha,
  });
  const gateId = store.openGate({ kind: "before_review:telegram", review_id: null, summary, ...target, request_ts: "2026-04-03T11:24:00Z" });
  await transport.post(gateId, summary);

  const client = {
    getPull: async () => {
      if (throws) throw throws;
      return pull;
    },
  };
  const logLines = [];
  const settled = await withdrawClosedPullGates({ store, client, transport, log: (line) => logLines.push(String(line)) });
  const close = () => {
    store.close();
    telegram.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, telegram, gateId, settled, log: logLines.join("\n"), close };
}

const OPEN = { number: 143, state: "open", merged_at: null, closed_at: null, html_url: "https://github.com/example/orders-svc/pull/143" };
const MERGED = { ...OPEN, state: "closed", merged_at: MERGED_AT, closed_at: MERGED_AT };
const CLOSED_WITHOUT_MERGE = { ...OPEN, state: "closed", merged_at: null, closed_at: MERGED_AT };

test("a merged pull request settles its gate and rewrites the message in place", async () => {
  const f = await sweepFixture({ pull: MERGED });
  try {
    assert.equal(f.settled, 1);
    const gate = f.store.getGate(f.gateId);
    assert.equal(gate.state, "withdrawn");
    assert.match(gate.reason, /merged at 2026-04-03 11:10Z, before the pass could run/);

    const message = f.telegram.messages.at(-1);
    assert.match(message.text, /<b>withdrawn<\/b> by harness: pull request merged at/);
    assert.deepEqual(message.reply_markup.inline_keyboard, [], "the approve and reject buttons are gone with the ask");
    assert.match(f.log, /gate .* withdrawn: pull request merged/);
  } finally {
    f.close();
  }
});

test("a pull request closed without merge says so rather than claiming a merge", async () => {
  const f = await sweepFixture({ pull: CLOSED_WITHOUT_MERGE });
  try {
    assert.match(f.store.getGate(f.gateId).reason, /closed at 2026-04-03 11:10Z/);
    assert.doesNotMatch(f.store.getGate(f.gateId).reason, /merged/);
  } finally {
    f.close();
  }
});

test("a deleted pull request is a 404, and a 404 is terminal", async () => {
  const f = await sweepFixture({ pull: null, throws: Object.assign(new Error("GET /repos/example/orders-svc/pulls/143 → 404: Not Found"), { status: 404 }) });
  try {
    const gate = f.store.getGate(f.gateId);
    assert.equal(gate.state, "withdrawn");
    assert.match(gate.reason, /pull request is gone \(404\)/);
  } finally {
    f.close();
  }
});

test("a timeout says nothing about the pull request, so the gate keeps waiting", async () => {
  const f = await sweepFixture({ pull: OPEN, throws: Object.assign(new Error("github api answered nothing"), { status: 504 }) });
  try {
    assert.equal(f.settled, 0);
    assert.equal(f.store.getGate(f.gateId).state, "pending", "it is asked again next cycle");
    assert.equal(f.telegram.messages.at(-1).reply_markup.inline_keyboard.length, 1, "the gate is still decidable");
    assert.match(f.log, /could not be read .* it stays pending/);
  } finally {
    f.close();
  }
});

test("an open pull request is left alone", async () => {
  const f = await sweepFixture({ pull: OPEN });
  try {
    assert.equal(f.settled, 0);
    assert.equal(f.store.getGate(f.gateId).state, "pending");
    assert.equal(f.telegram.edits.length, 0, "and its message is not touched");
  } finally {
    f.close();
  }
});

test("a composed review on a post gate is not withdrawn when the pull request merges", async () => {
  // The review already exists and GitHub takes reviews on merged pull requests, so an approval there
  // still posts. Only the ask for a pass that can never run is settled.
  const f = await sweepFixture({ pull: MERGED });
  try {
    const store = f.store;
    const postGate = store.openGate({ kind: "before_post:telegram", review_id: null, summary: "composed review", owner: "example", repo: "orders-svc", pr: 143, head_sha: "9c1f2be4" });
    const settledAgain = await withdrawClosedPullGates({ store, client: { getPull: async () => MERGED }, log: () => {} });
    assert.equal(settledAgain, 0, "the post gate was already settled as a task gate, and nothing else is waiting");
    assert.equal(store.getGate(postGate).state, "pending", "a post gate keeps its approval offer");
  } finally {
    f.close();
  }
});
