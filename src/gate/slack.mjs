/**
 * Slack gate.
 *
 * Target resolution: a pinned channel or IM id, then an existing self DM, then a private channel by
 * name. A user token (`xoxc`/`xoxd`) can post and read but Slack refuses `conversations.open` for
 * your own DM; a `botToken` gets true DMs, and `webhook` can post but never read, so the decision
 * then comes from src/cli/gate.mjs. Buttons need a request URL the bot does not have, so the decision
 * is text in the thread.
 */

const SLACK_API = "https://slack.com/api";

export function parseDecision(text, { gateIds, allowUsers = [], user }) {
  if (!text || !gateIds.size) return null;
  if (allowUsers.length && !allowUsers.includes(user)) return null;
  const match = /^\s*(approve|reject|hold)\s+([0-9a-f-]{4,12})\b\s*(.*)$/i.exec(text);
  if (!match) return null;
  const [, command, gateId, rest] = match;
  if (!gateIds.has(gateId)) return null;
  return { command: command.toLowerCase(), gateId, reason: rest.trim() || null };
}

export function createSlackGate({ cfg, store, token, cookie, log = () => {} }) {
  const slack = cfg.gate.slack;
  // Overridable for a proxy or a test double; the shape of the API is the same.
  const apiBase = (slack.apiBaseUrl || SLACK_API).replace(/\/$/, "");

  async function call(method, payload = {}) {
    const response = await fetch(`${apiBase}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
        ...(cookie ? { Cookie: `d=${cookie}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!body.ok) log(`slack ${method} failed: ${body.error}`);
    return body;
  }

  async function resolveChannel() {
    const pinned = (cfg._env ?? process.env)[slack.channelEnv];
    if (pinned) return pinned;

    const authed = await call("auth.test");
    if (authed.ok) {
      // A self DM exists once you have messaged yourself in the client; opening one with a user
      // token is refused, so this reads the existing channel instead of creating it.
      const list = await fetch(`${apiBase}/conversations.list?types=im&limit=200`, {
        headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
      }).then((response) => response.json());
      const self = (list.channels ?? []).find((channel) => channel.user === authed.user_id);
      if (self) return self.id;
    }

    const channels = await fetch(`${apiBase}/conversations.list?types=private_channel,public_channel&limit=500`, {
      headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
    }).then((response) => response.json());
    const named = (channels.channels ?? []).find((channel) => channel.name === slack.channelName);
    if (named) {
      log(`slack gate target: #${named.name} (${named.id}); pin it in ${slack.channelEnv} to skip discovery`);
      return named.id;
    }
    return "";
  }

  const webhookUrl = () => (cfg._env ?? process.env)[slack.webhookUrlEnv] ?? "";

  async function post(gateId, summary) {
    if (slack.transport === "webhook") {
      // An incoming webhook can only talk, never listen: it cannot read a decision back, so the
      // decision is taken with src/cli/gate.mjs against the same queue.
      const url = webhookUrl();
      if (!url) {
        log(`transport=webhook but ${slack.webhookUrlEnv} is unset; gate ${gateId} stays queued`);
        return false;
      }
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          text: `laidback-reviewer gate ${gateId}.\n\n${summary}\n\nDecide with: node src/cli/gate.mjs ${gateId} approve`,
        }),
      });
      if (!response.ok) log(`slack webhook post failed: ${response.status}`);
      return response.ok;
    }

    const channel = await resolveChannel();
    if (!channel) {
      log(`no slack channel for the gate: set ${slack.channelEnv} or create #${slack.channelName}`);
      return false;
    }
    const header = `laidback-reviewer gate ${gateId}. Reply in this thread: \`approve ${gateId}\` or \`reject ${gateId} <reason>\`.`;
    const sent = await call("chat.postMessage", { channel, text: `${header}\n\n${summary}`, unfurl_links: false });
    if (sent.ok) store.setSlackTs({ id: gateId, ts: sent.ts });
    return sent.ok;
  }

  /** Read the thread of each pending gate and apply any decision in it. */
  async function readDecisions() {
    if (slack.transport === "webhook") return [];
    const pending = store.pendingGates().filter((gate) => gate.kind.endsWith(":slack") && gate.slack_ts);
    if (!pending.length) return [];
    const channel = await resolveChannel();
    if (!channel) return [];

    const allowUsers = ((cfg._env ?? process.env)[slack.allowUsersEnv] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const applied = [];

    for (const gate of pending) {
      const thread = await fetch(`${apiBase}/conversations.replies?${new URLSearchParams({ channel, ts: gate.slack_ts, limit: "200" })}`, {
        headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
      }).then((response) => response.json());

      const gateIds = new Set([gate.id]);
      for (const message of thread.messages ?? []) {
        const decision = parseDecision(message.text, { gateIds, allowUsers, user: message.user });
        if (!decision) continue;
        const state = decision.command === "approve" ? "approved" : decision.command === "reject" ? "rejected" : "held";
        applied.push(store.decideGate({ id: decision.gateId, state, decided_by: message.user ?? "slack", reason: decision.reason }));
        gateIds.delete(decision.gateId);
      }
    }
    return applied;
  }

  /** Gates nobody answered stop blocking the queue. */
  function expire() {
    const limit = Date.now() - cfg.gate.timeoutHours * 3600_000;
    const expired = store.pendingGates().filter((gate) => Date.parse(gate.created_at) < limit);
    for (const gate of expired) {
      store.decideGate({ id: gate.id, state: cfg.gate.onTimeout === "skip" ? "skipped" : "expired", decided_by: "timeout" });
      log(`gate ${gate.id} ${cfg.gate.onTimeout === "skip" ? "skipped" : "expired"} after ${cfg.gate.timeoutHours}h`);
    }
    return expired.length;
  }

  return { post, readDecisions, expire, resolveChannel, call };
}
