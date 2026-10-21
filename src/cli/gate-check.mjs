#!/usr/bin/env node
/**
 * Live check of the Slack gate, without a pull request.
 *
 * Authenticates, resolves the channel the gate would use, posts a gate message, and polls the thread
 * for a decision. It writes nothing to GitHub and uses a throwaway state file, so approving its
 * message has no effect on a real review.
 *
 *   npm run gate:check              posts and waits up to 180s
 *   npm run gate:check -- --timeout 60
 */

import { loadConfig, secret } from "../config.mjs";
import { createSlackGate } from "../gate/slack.mjs";
import { openStore } from "../proposal/store.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cfg = loadConfig();
const slackCfg = cfg.gate.slack;
const token = secret(cfg, slackCfg.tokenEnv);
const cookie = secret(cfg, slackCfg.cookieEnv);

if (slackCfg.transport === "webhook" ? !process.env[slackCfg.webhookUrlEnv] : !token) {
  console.error(
    slackCfg.transport === "webhook"
      ? `${slackCfg.webhookUrlEnv} is unset. Set the Slack app's incoming-webhook URL there. Note that a webhook cannot read a decision back, so approvals are taken with node src/cli/gate.mjs.`
      : [
          `${slackCfg.tokenEnv} is unset.`,
          "For gate.slack.transport=userToken set a token pair: SLACK_MCP_XOXC_TOKEN (xoxc-...) and SLACK_MCP_XOXD_TOKEN (xoxd-...), copied from a logged-in Slack web session.",
          "For transport=botToken set SLACK_MCP_XOXC_TOKEN to an app bot token (xoxb-...) instead.",
        ].join("\n"),
  );
  process.exit(1);
}

const allowUsers = ((process.env[slackCfg.allowUsersEnv] ?? "") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
if (!allowUsers.length) {
  console.log(`warning: ${slackCfg.allowUsersEnv} is empty, so any member of the gate channel can approve`);
}

// A separate database: this must not mark real gates as decided.
const store = openStore(process.env.LAIDBACK_GATE_CHECK_DB ?? "/tmp/laidback-gate-check.db");
const slack = createSlackGate({ cfg, store, token, cookie, log: (line) => console.log(`  ${line}`) });

const auth = await slack.call("auth.test");
if (!auth.ok) {
  console.error(`auth.test failed: ${auth.error}. Check the token (${slackCfg.tokenEnv}) and, for xoxc, the matching ${slackCfg.cookieEnv}.`);
  process.exit(1);
}
console.log(`auth: ${auth.user} in ${auth.team} (user_id ${auth.user_id})`);
if (allowUsers.length && !allowUsers.includes(auth.user_id)) {
  console.log(`note: your own id ${auth.user_id} is not in ${slackCfg.allowUsersEnv}; you would not be able to approve`);
}

const channel = await slack.resolveChannel();
if (!channel) {
  console.error(
    `No channel resolved. Either set ${slackCfg.channelEnv} to a channel or IM id, or create a private channel named "${slackCfg.channelName}" and invite the token's user. A self DM only appears once you have messaged yourself in the Slack client.`,
  );
  process.exit(1);
}
console.log(`channel: ${channel}`);

const gateId = store.openGate({
  kind: "check:slack",
  review_id: null,
  summary: "Gate check from src/cli/gate-check.mjs. If this is readable, presenting works.",
});

const body = [
  "If this is readable, presenting works.",
  "",
  "Reply in this thread with:",
  "",
  `\`approve ${gateId}\``,
  "",
  "Approving changes nothing: this row lives in a throwaway state file.",
].join("\n");

if (!(await slack.post(gateId, body))) {
  console.error("posting failed; see the slack chat.postMessage line above");
  process.exit(1);
}

if (slackCfg.transport === "webhook") {
  console.log("transport=webhook: an incoming webhook cannot be read back, so this check only proves the message arrives.");
  console.log("Decide with: node src/cli/gate.mjs <gate id> approve");
}

const timeoutMs = Number(arg("timeout", "180")) * 1000;
const deadline = Date.now() + timeoutMs;
console.log(`posted gate ${gateId}; waiting up to ${Math.round(timeoutMs / 1000)}s for a decision in the thread`);

while (Date.now() < deadline) {
  const applied = await slack.readDecisions();
  if (applied.length) {
    const gate = applied[0];
    console.log(`decision read: ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
    console.log("reading works: the loop would now post the approved review on its next cycle.");
    store.close();
    process.exit(gate.state === "approved" ? 0 : 2);
  }
  await sleep(3000);
}

console.log(`no decision within ${Math.round(timeoutMs / 1000)}s: posting worked, reading was never satisfied`);
store.close();
process.exit(2);
