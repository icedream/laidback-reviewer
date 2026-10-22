/**
 * The webhook transport and the pending-queue ceiling.
 *
 * A webhook can speak but not listen, so the two things that must hold are: the message still goes
 * out, and no decision is ever invented from it.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createGate } from "../../src/gate/gate.mjs";
import { createSlackGate } from "../../src/gate/slack.mjs";
import { openStore } from "../../src/proposal/store.mjs";

const slackCfg = (overrides = {}) => ({
  reviews: { dryRun: false, maxComments: 25 },
  gate: {
    channel: "slack",
    beforePost: true,
    beforeReview: false,
    timeoutHours: 24,
    onTimeout: "hold",
    maxPending: 5,
    slack: {
      transport: "webhook",
      channelEnv: "GATE_CHANNEL",
      channelName: "gate",
      allowUsersEnv: "GATE_USERS",
      tokenEnv: "GATE_TOKEN",
      cookieEnv: "GATE_COOKIE",
      webhookUrlEnv: "GATE_WEBHOOK",
      apiBaseUrl: "https://slack.invalid",
      ...overrides,
    },
  },
  tools: { allowHosts: ["127.0.0.1"] },
});

function webhookServer() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("ok");
  });
  return {
    received,
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/services/T/B/webhook`))),
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

test("webhook transport posts the gate and never claims a decision", async () => {
  const hooks = webhookServer();
  const url = await hooks.start();
  const store = openStore(":memory:");
  try {
    const cfg = slackCfg();
    cfg._env = { GATE_WEBHOOK: url };
    const slack = createSlackGate({ cfg, store, token: "", cookie: "", log: () => {} });

    const gateId = store.openGate({ kind: "before_post:slack", review_id: null, summary: "composed review text" });
    assert.equal(await slack.post(gateId, "composed review text"), true);
    assert.equal(hooks.received.length, 1);
    assert.match(hooks.received[0].text, /laidback-reviewer gate [0-9a-f-]{8}/);
    assert.match(hooks.received[0].text, /node src\/cli\/gate\.mjs [0-9a-f-]{8} approve/);

    assert.deepEqual(await slack.readDecisions(), [], "nothing is read back over a webhook");
    assert.deepEqual(store.pendingGates().map((gate) => gate.state), ["pending"]);
  } finally {
    store.close();
    hooks.close();
  }
});

test("webhook transport without a URL queues rather than pretending to present", async () => {
  const store = openStore(":memory:");
  try {
    const cfg = slackCfg();
    cfg._env = {};
    const logs = [];
    const slack = createSlackGate({ cfg, store, token: "", cookie: "", log: (line) => logs.push(line) });
    const gateId = store.openGate({ kind: "before_post:slack", review_id: null, summary: "x" });

    assert.equal(await slack.post(gateId, "x"), false);
    assert.match(logs.join("\n"), /GATE_WEBHOOK is unset/);
  } finally {
    store.close();
  }
});

test("a full pending queue stops presenting new gates but keeps queueing them", async () => {
  const store = openStore(":memory:");
  try {
    const cfg = { ...slackCfg({ transport: "cli" }), tools: { allowHosts: [] } };
    cfg.gate.maxPending = 2;
    const logs = [];
    const gate = createGate({ cfg, store, log: (line) => logs.push(line), transport: null });

    const first = await gate.open({ stage: "before_post", reviewId: null, summary: "one" });
    const second = await gate.open({ stage: "before_post", reviewId: null, summary: "two" });
    const third = await gate.open({ stage: "before_post", reviewId: null, summary: "three" });

    assert.ok(first.gateId && second.gateId && third.gateId, "all three are still recorded");
    assert.equal(third.queueFull, true, "the third is queued without a presentation");
    assert.match(logs.join("\n"), /gate queue holds 3 of 2/);
    assert.equal(store.pendingGates().length, 3, "the overflow is queued in the database, not lost");
  } finally {
    store.close();
  }
});
