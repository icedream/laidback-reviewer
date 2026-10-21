/**
 * Gate transport selection. A manual run that queues a gate nobody can see is worse than one that
 * says up front it cannot present it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { slackGateFromConfig } from "../../src/gate/slack.mjs";

const cfgFor = ({ channel = "slack", transport = "userToken" } = {}) => ({
  gate: {
    channel,
    slack: {
      transport,
      tokenEnv: "SLACK_MCP_XOXC_TOKEN",
      cookieEnv: "SLACK_MCP_XOXD_TOKEN",
      webhookUrlEnv: "LAIDBACK_SLACK_WEBHOOK",
      apiBaseUrl: "https://slack.com/api",
      channelEnv: "LAIDBACK_SLACK_CHANNEL",
      channelName: "laidback-reviewer-gate",
      allowUsersEnv: "LAIDBACK_SLACK_USERS",
      reactions: { approve: ["white_check_mark"], reject: ["x"], hold: ["hourglass_flowing_sand"] },
      seedReactions: "auto",
    },
  },
});

test("a missing credential leaves the gate queued and says so", () => {
  const notes = [];
  const slack = slackGateFromConfig({ cfg: cfgFor(), store: {}, env: {}, log: (line) => notes.push(line) });

  assert.equal(slack, null);
  assert.match(notes.join("\n"), /SLACK_MCP_XOXC_TOKEN is unset/);
  assert.match(notes.join("\n"), /src\/cli\/gate\.mjs/);
});

test("the transport is built once the token pair is present", () => {
  const slack = slackGateFromConfig({
    cfg: cfgFor(),
    store: {},
    env: { SLACK_MCP_XOXC_TOKEN: "xoxc-x", SLACK_MCP_XOXD_TOKEN: "xoxd-y" },
    log: () => {},
  });

  assert.equal(typeof slack?.post, "function");
  assert.equal(typeof slack?.readDecisions, "function");
});

test("a webhook transport is satisfied by its url alone", () => {
  const cfg = cfgFor({ transport: "webhook" });
  assert.equal(slackGateFromConfig({ cfg, store: {}, env: {}, log: () => {} }), null);

  const slack = slackGateFromConfig({ cfg, store: {}, env: { LAIDBACK_SLACK_WEBHOOK: "https://hooks.slack.test/x" }, log: () => {} });
  assert.equal(typeof slack?.post, "function");
});

test("the cli and none channels build no transport", () => {
  for (const channel of ["cli", "none"]) {
    const cfg = cfgFor({ channel });
    assert.equal(slackGateFromConfig({ cfg, store: {}, env: { SLACK_MCP_XOXC_TOKEN: "xoxc-x" }, log: () => {} }), null, channel);
  }
});
