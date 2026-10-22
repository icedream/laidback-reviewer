/**
 * Slack gate.
 *
 * Target resolution: a pinned channel or IM id, then an existing self DM, then a private channel by
 * name. A user token (`xoxc`/`xoxd`) can post and read but Slack refuses `conversations.open` for
 * your own DM; a `botToken` gets true DMs, and `webhook` can post but never read, so the decision
 * then comes from src/cli/gate.mjs. Interactive buttons need a request URL the bot does not have, so
 * the decision is an emoji reaction on the gate message, or text in the thread.
 */

import { renderInlineComment } from "./gate.mjs";
import { requestRerun } from "./gate.mjs";

const SLACK_API = "https://slack.com/api";

// Slack allows 40k characters in a message; a finding is not served whole in a wall of text.
const SLACK_CLAMP = 3500;
const clamp = (text) => (text.length > SLACK_CLAMP ? `${text.slice(0, SLACK_CLAMP - 1)}…` : text);

export function parseDecision(text, { gateIds, allowUsers = [], user }) {
  if (!text || !gateIds.size) return null;
  if (allowUsers.length && !allowUsers.includes(user)) return null;
  const match = /^\s*(approve|reject|hold|rerun)\s+([0-9a-f-]{4,12})\b\s*(.*)$/i.exec(text);
  if (!match) return null;
  const [, command, gateId, rest] = match;
  if (!gateIds.has(gateId)) return null;
  return { command: command.toLowerCase(), gateId, reason: rest.trim() || null };
}

export const STATE_BY_COMMAND = { approve: "approved", reject: "rejected", hold: "held" };
export const RERUN_COMMAND = "rerun";

/**
 * An emoji on the gate message. Only the root message is read, so a reaction to somebody else's
 * reply is noise, and the allowlist applies exactly as it does to text. Order is approve, reject,
 * hold: the first one present decides.
 */
export function parseReactions(message, { allowUsers = [], reactions = {} } = {}) {
  for (const command of ["approve", "reject", "hold", "rerun"]) {
    const names = reactions[command] ?? [];
    for (const reaction of message?.reactions ?? []) {
      if (!names.includes(reaction.name)) continue;
      const user = (reaction.users ?? []).find((id) => !allowUsers.length || allowUsers.includes(id));
      if (user) return { command, emoji: reaction.name, user };
    }
  }
  return null;
}

/**
 * Build the transport from config and environment so every entry point presents a gate the same way.
 * Returns null, with the reason logged, when the channel is not slack or its credential is absent;
 * the gate still queues in SQLite and can be decided with src/cli/gate.mjs.
 */
export function slackGateFromConfig({ cfg, store, env = process.env, log = () => {} }) {
  if (cfg.gate.channel !== "slack") return null;
  const slack = cfg.gate.slack;
  const token = (env[slack.tokenEnv] ?? "").trim();
  const cookie = (env[slack.cookieEnv] ?? "").trim();
  const webhook = (env[slack.webhookUrlEnv] ?? "").trim();
  const missing = slack.transport === "webhook" ? !webhook : !token;
  if (missing) {
    const name = slack.transport === "webhook" ? slack.webhookUrlEnv : slack.tokenEnv;
    log(`gate.channel=slack but ${name} is unset: gates stay queued and are decided with node src/cli/gate.mjs`);
    return null;
  }
  return createSlackGate({ cfg, store, token, cookie, log });
}

export function createSlackGate({ cfg, store, token, cookie, log = () => {} }) {
  const slack = cfg.gate.slack;
  // Overridable for a proxy or a test double; the shape of the API is the same.
  const apiBase = (slack.apiBaseUrl || SLACK_API).replace(/\/$/, "");
  // Every Slack call gets a deadline: a hung read would stall the cycle that is meant to notice a
  // decision. A config object built outside the schema may omit the key, so the default lives here too.
  const slackTimeoutMs = Number(slack.timeoutMs) > 0 ? Number(slack.timeoutMs) : 15_000;
  const slackFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(slackTimeoutMs) });

  async function call(method, payload = {}) {
    const response = await slackFetch(`${apiBase}/${method}`, {
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

  let self = null;
  /** Cached identity of the token, so post and read agree on who is deciding. */
  async function whoAmI() {
    self ??= await call("auth.test");
    return self;
  }

  const allowUsers = () => ((cfg._env ?? process.env)[slack.allowUsersEnv] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

  async function resolveChannel() {
    const pinned = (cfg._env ?? process.env)[slack.channelEnv];
    if (pinned) return pinned;

    const authed = await whoAmI();
    if (authed.ok) {
      // A self DM exists once you have messaged yourself in the client; opening one with a user
      // token is refused, so this reads the existing channel instead of creating it.
      const list = await slackFetch(`${apiBase}/conversations.list?types=im&limit=200`, {
        headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
      }).then((response) => response.json());
      const self = (list.channels ?? []).find((channel) => channel.user === authed.user_id);
      if (self) return self.id;
    }

    const channels = await slackFetch(`${apiBase}/conversations.list?types=private_channel,public_channel&limit=500`, {
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

  async function post(gateId, summary, { reviewId = null } = {}) {
    if (slack.transport === "webhook") {
      // An incoming webhook can only talk, never listen: it cannot read a decision back, so the
      // decision is taken with src/cli/gate.mjs against the same queue.
      const url = webhookUrl();
      if (!url) {
        log(`transport=webhook but ${slack.webhookUrlEnv} is unset; gate ${gateId} stays queued`);
        return false;
      }
      const response = await slackFetch(url, {
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
    // Where the read marker sat before this gate, so it can be put back afterwards.
    const history = await slackFetch(`${apiBase}/conversations.history?channel=${channel}&limit=1`, {
      headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
    }).then((response) => response.json());
    const markerBefore = history.messages?.[0]?.ts ?? "";
    const hint = Object.entries(slack.reactions ?? {})
      .flatMap(([command, names]) => names.slice(0, 1).map((name) => `:${name}: ${command}`))
      .join(", ");
    const rerunHint = reviewId && slack.reactions?.rerun?.length ? ` or :${slack.reactions.rerun[0]}: for another pass` : "";
    const header = `laidback-reviewer gate ${gateId}. React ${hint}, or reply \`approve ${gateId}\` / \`reject ${gateId} <reason>\`${rerunHint}.`;
    const sent = await call("chat.postMessage", { channel, text: `${header}\n\n${summary}`, unfurl_links: false });
    if (!sent.ok) return false;
    store.setSlackTs({ id: gateId, ts: sent.ts });
    await postInlineComments({ gateId, channel, threadTs: sent.ts, reviewId });
    // Seeding a reaction the decider would click is a trap: with a user token the poster and the
    // decider are the same identity, so the click would clear the chip instead of setting it.
    // Only chips that mean something here: another pass needs a composed review to replace.
    const names = Object.entries(slack.reactions ?? {})
      .filter(([command]) => command !== "rerun" || reviewId)
      .flatMap(([, list]) => list);
    const allow = allowUsers();
    const me = (await whoAmI()).user_id ?? "";
    const seed = slack.seedReactions === "always" || (slack.seedReactions === "auto" && allow.length > 0 && !allow.includes(me));
    if (seed) {
      for (const name of names) await call("reactions.add", { channel, name, timestamp: sent.ts });
    } else {
      log(`gate ${gateId}: not seeding its own reactions; the posting user ${me || "?"} may decide`);
    }
    await markUnread({ gateId, channel, marker: markerBefore, me });
    return true;
  }

  /**
   * Slack marks a message you wrote as read the moment it lands, so a gate posted into your own DM
   * leaves nothing to notice. Putting the read marker back to where it was before the post makes the
   * thread unread again, which is the only signal the client gives for a conversation you own.
   */
  async function markUnread({ gateId, channel, marker, me }) {
    const mode = slack.markUnread ?? "auto";
    if (mode === "never") return;
    // auto only applies where the poster is one of the deciders, which is the self-DM case. With a bot
    // or webhook identity the message arrives unread on its own.
    if (mode === "auto" && !(allowUsers().length && allowUsers().includes(me))) return;
    if (!marker) {
      log(`gate ${gateId}: the channel was empty before the gate, so there is no marker to put back`);
      return;
    }
    const marked = await call("conversations.mark", { channel, ts: marker });
    if (marked.ok) log(`gate ${gateId}: read marker set back to ${marker}, so the gate shows as unread`);
  }

  /**
   * One reply per inline comment. The summary carries positions; the thread carries what is actually
   * being said about each line, which is the part a decision needs.
   */
  async function postInlineComments({ gateId, channel, threadTs, reviewId }) {
    if (!reviewId || !slack.maxCommentReplies) return;
    const comments = store.commentsFor(reviewId);
    if (!comments.length) return;

    const tsList = [];
    for (const comment of comments.slice(0, slack.maxCommentReplies)) {
      const reply = await call("chat.postMessage", { channel, thread_ts: threadTs, text: clamp(renderInlineComment(comment)), unfurl_links: false });
      if (reply.ok && reply.ts) tsList.push(reply.ts);
    }
    if (comments.length > slack.maxCommentReplies) {
      const rest = `${comments.length - slack.maxCommentReplies} further inline comments are in the review artifact, not in this thread.`;
      const reply = await call("chat.postMessage", { channel, thread_ts: threadTs, text: rest, unfurl_links: false });
      if (reply.ok && reply.ts) tsList.push(reply.ts);
    }
    // Recorded so reading the thread back never treats one of these as a decision.
    store.recordCommentTs({ id: gateId, tsList });
    log(`gate ${gateId}: ${tsList.length} inline comments posted in the thread`);
  }

  /** Read the thread of each pending gate and apply any decision in it. */
  async function readDecisions() {
    if (slack.transport === "webhook") return [];
    const pending = store.pendingGates().filter((gate) => gate.kind.endsWith(":slack") && gate.slack_ts);
    if (!pending.length) return [];
    const channel = await resolveChannel();
    if (!channel) return [];

    const allow = allowUsers();
    const applied = [];

    for (const gate of pending) {
      const thread = await slackFetch(`${apiBase}/conversations.replies?${new URLSearchParams({ channel, ts: gate.slack_ts, limit: "200" })}`, {
        headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: `d=${cookie}` } : {}) },
      }).then((response) => response.json());

      const gateIds = new Set([gate.id]);
      const ours = new Set(JSON.parse(gate.comment_ts ?? "[]"));
      for (const message of thread.messages ?? []) {
        if (ours.has(message.ts)) continue;
        const decision = parseDecision(message.text, { gateIds, allowUsers: allow, user: message.user });
        if (!decision) continue;
        if (decision.command === RERUN_COMMAND) {
          const target = pending.find((entry) => entry.id === decision.gateId);
          requestRerun({ store, gate: target, by: message.user ?? "slack", log });
          applied.push({ id: decision.gateId, state: "rerun", decided_by: message.user ?? "slack" });
          gateIds.delete(decision.gateId);
          continue;
        }
        applied.push(store.decideGate({ id: decision.gateId, state: STATE_BY_COMMAND[decision.command], decided_by: message.user ?? "slack", reason: decision.reason }));
        gateIds.delete(decision.gateId);
      }

      // No text answer: fall back to a reaction on the gate message itself.
      if (gateIds.has(gate.id)) {
        const reaction = parseReactions((thread.messages ?? [])[0], { allowUsers: allow, reactions: slack.reactions });
        if (reaction?.command === RERUN_COMMAND) {
          requestRerun({ store, gate, by: reaction.user, log });
          applied.push({ id: gate.id, state: "rerun", decided_by: reaction.user });
          gateIds.delete(gate.id);
        } else if (reaction) {
          applied.push(store.decideGate({ id: gate.id, state: STATE_BY_COMMAND[reaction.command], decided_by: reaction.user, reason: `reacted ${reaction.emoji}` }));
          gateIds.delete(gate.id);
        }
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
