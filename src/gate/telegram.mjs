/**
 * Telegram gate transport.
 *
 * A bot cannot read emoji reactions in an ordinary chat, so the tap target here is an inline keyboard and
 * the answer arrives as a callback query. The gate message stays short on purpose: the verdict and one
 * line per finding, with a numbered button that edits the message into that finding's full text. That
 * reads on a phone without a wall of thread replies.
 */

import { parseCallback, summaryHtml, findingHtml, decisionRows, findingRows, backRows, rerunRow, toastFor } from "./telegram-format.mjs";
import { requestRerun } from "./gate.mjs";
import { expirePending } from "./expire.mjs";

const OFFSET_KEY = "telegram_update_offset";
const LEASE_KEY = "telegram_poller_lease";
// A poller that died leaves its lease behind; after this long the next process may take it over.
const LEASE_STALE_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TELEGRAM_TEXT_LIMIT = 4096;

export function telegramGateFromConfig({ cfg, store, env = process.env, log = () => {}, apiBase }) {
  const telegram = cfg.gate.telegram;
  const token = env[telegram.botTokenEnv];
  const chatId = env[telegram.chatIdEnv] ?? telegram.chatId;
  if (!token || !chatId) return null;
  const allowUsers = (env[telegram.allowUsersEnv] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return createTelegramGate({ cfg, store, token, chatId, allowUsers, log, apiBase });
}

export function createTelegramGate({ cfg, store, token, chatId, allowUsers = [], log = () => {}, apiBase = "https://api.telegram.org" }) {
  const telegram = cfg.gate.telegram;

  async function call(method, payload = {}) {
    // A rate limit is a wait, not a failure: honour retry_after once before saying anything went wrong.
    for (let attempt = 0; ; attempt += 1) {
      // A long-poll holds the response open for as long as we asked the channel to wait, so the local
      // deadline has to sit above that or the client cancels a request the channel is still answering.
      const holdMs = method === "getUpdates" ? Math.max(0, Number(telegram.longPollSeconds ?? 0)) * 1000 : 0;
      const response = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(telegram.timeoutMs + holdMs),
      });
      const body = await response.json().catch(() => ({}));
      const retryAfterMs = Math.min(Number(body.parameters?.retry_after ?? 1) * 1000, 60_000);
      if (response.status === 429 && attempt === 0) {
        await sleep(retryAfterMs);
        continue;
      }
      if (!response.ok || body.ok === false) {
        const error = new Error(`telegram ${method}: ${body.description ?? `HTTP ${response.status}`}`);
        // A 409 means another poller holds the token's slot, usually a previous process whose long-poll
        // request has not been reaped yet. Asking again immediately only keeps stealing it back.
        error.retryAfterMs = response.status === 429 ? retryAfterMs : response.status === 409 ? 5_000 : 0;
        throw error;
      }
      return body.result;
    }
  }

  /**
   * One process may poll a bot token. Two consumers of getUpdates means 409s and decisions that land in
   * whichever process happened to be asking, so the poller takes a lease and the command line checks it.
   */
  function claimLease() {
    const now = new Date();
    const raw = store.getMeta(LEASE_KEY);
    if (raw) {
      try {
        const held = JSON.parse(raw);
        if (Number(held.pid) !== process.pid && now.getTime() - Date.parse(held.at ?? 0) < LEASE_STALE_MS) return false;
      } catch {
        // A lease that cannot be read is no longer holding anything.
      }
    }
    store.setMeta(LEASE_KEY, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
    return true;
  }

  function leaseHeld() {
    const raw = store.getMeta(LEASE_KEY);
    if (!raw) return null;
    try {
      const held = JSON.parse(raw);
      if (Date.now() - Date.parse(held.at ?? 0) < LEASE_STALE_MS) return held;
    } catch {
      return null;
    }
    return null;
  }

  function releaseLease() {
    if (leaseHeld()?.pid === process.pid) store.setMeta(LEASE_KEY, "");
  }

  async function post(gateId, summary, { reviewId = null } = {}) {
    const comments = reviewId ? store.commentsFor(reviewId) : [];
    const shown = comments.slice(0, telegram.maxFindingButtons);
    const offersRerun = Boolean(reviewId) && telegram.rerunButton !== false;
    let text = summaryHtml(summary, { comments: shown, maxFindings: telegram.maxFindingButtons });
    // The button alone reads like a fourth verdict word, so the message says what it does.
    if (offersRerun) text += "\n\n↻ another pass runs a fresh review of this head and supersedes this proposal.";
    if (text.length > TELEGRAM_TEXT_LIMIT) text = `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}\n…`;

    const keyboard = [decisionRows(gateId), ...findingRows(gateId, shown.length), ...(offersRerun ? [rerunRow(gateId)] : [])];
    try {
      const sent = await call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        disable_notification: !telegram.notify,
        reply_markup: { inline_keyboard: keyboard },
      });
      store.setChannelMsgId({ id: gateId, msg_id: String(sent.message_id) });
      log(`gate ${gateId} posted to Telegram chat ${chatId}${shown.length ? ` with ${shown.length} finding button(s)` : ""}`);
      return { messageId: sent.message_id };
    } catch (error) {
      log(`gate ${gateId} could not be posted to Telegram: ${error.message}`);
      return null;
    }
  }

  async function editForFinding(gateId, index, cb) {
    const gate = store.getGate(gateId);
    if (!gate?.review_id) return "nothing to show";
    const comments = store.commentsFor(gate.review_id);
    const comment = comments[index];
    if (!comment) return "that finding is gone";
    await call("editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: findingHtml(gate, comment, index, comments.length),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [decisionRows(gateId), backRows(gateId, comments.length)] },
    });
    return null;
  }

  async function editBack(gateId, cb, reviewId) {
    const gate = store.getGate(gateId);
    const comments = reviewId ? store.commentsFor(reviewId) : [];
    await call("editMessageText", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: summaryHtml(gate?.summary ?? "", { comments: comments.slice(0, telegram.maxFindingButtons), maxFindings: telegram.maxFindingButtons }),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [decisionRows(gateId), ...findingRows(gateId, comments.length)] },
    });
  }

  async function settle(gateId, cb, state, decidedBy) {
    const gate = store.getGate(gateId);
    const banner = `\n\n<b>${state}</b> by ${decidedBy}`;
    // The last page the reviewer saw may have been one finding. Redrawing the summary is what makes the
    // result readable: reusing the callback's text leaves the message on that finding with no way back.
    const comments = gate?.review_id ? store.commentsFor(gate.review_id) : [];
    const text = gate
      ? `${summaryHtml(gate.summary ?? "", { comments: comments.slice(0, telegram.maxFindingButtons), maxFindings: telegram.maxFindingButtons })}${banner}`
      : `${String(cb.message.text ?? "").slice(0, TELEGRAM_TEXT_LIMIT - banner.length)}${banner}`;
    try {
      await call("editMessageText", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: text.slice(0, TELEGRAM_TEXT_LIMIT),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      // "message is not modified" is cosmetic: the decision is already stored.
      log(`gate ${gateId} decided, its Telegram message could not be updated: ${error.message}`);
    }
    return gate;
  }

  async function readDecisions() {
    if (!claimLease()) {
      log("another process is polling this bot token; its cycle reads the decisions");
      return [];
    }
    const offset = Number(store.getMeta(OFFSET_KEY) ?? "0");
    let updates;
    try {
      updates = await call("getUpdates", {
        offset,
        limit: 100,
        timeout_ms: Number(telegram.longPollSeconds ?? 0),
        allowed_updates: ["callback_query"],
      });
    } catch (error) {
      log(`telegram getUpdates failed: ${error.message}`);
      if (error.retryAfterMs) await sleep(Math.min(error.retryAfterMs, LEASE_STALE_MS));
      return [];
    }

    const applied = [];
    for (const update of updates ?? []) {
      store.setMeta(OFFSET_KEY, String(update.update_id + 1));
      const cb = update.callback_query;
      if (!cb) continue;

      const parsed = parseCallback(cb.data ?? "");
      if (!parsed) continue;
      const gate = store.getGate(parsed.gateId);
      const who = `telegram:${cb.from?.id ?? "?"}${cb.from?.username ? ` @${cb.from.username}` : ""}`;
      let toast = "";

      if (parsed.kind === "finding" || parsed.kind === "back") {
        if (!gate) {
          // A tap on a message whose gate is gone: say so rather than editing an empty body.
          toast = "this gate is not here any more";
        } else {
          try {
            // A failed edit is cosmetic: the tap is acknowledged either way, and the gate stays decidable.
            if (parsed.kind === "finding") toast = (await editForFinding(parsed.gateId, parsed.index, cb)) ?? "";
            else await editBack(parsed.gateId, cb, gate.review_id ?? null);
          } catch (error) {
            log(`gate ${parsed.gateId}: the ${parsed.kind} view could not be shown in Telegram: ${error.message}`);
            toast = "could not show that here";
          }
        }
      } else if (parsed.kind === "rerun") {
        if (!gate || gate.state !== "pending") {
          toast = "already decided";
        } else if (allowUsers.length && !allowUsers.includes(String(cb.from?.id ?? ""))) {
          log(`gate ${parsed.gateId}: ${who} is not in ${cfg.gate.telegram.allowUsersEnv}`);
          toast = "not on the allow list";
        } else {
          requestRerun({ store, gate, by: who, log });
          applied.push({ id: parsed.gateId, state: "rerun", decided_by: who });
          toast = "another pass requested";
          await settle(parsed.gateId, cb, "another pass requested", who);
        }
      } else if (!gate || gate.state !== "pending") {
        toast = "already decided";
        if (gate) await settle(parsed.gateId, cb, gate.state, gate.decided_by ?? "someone");
      } else if (allowUsers.length && !allowUsers.includes(String(cb.from?.id ?? ""))) {
        log(`gate ${parsed.gateId}: ${who} is not in ${cfg.gate.telegram.allowUsersEnv}`);
        toast = "not on the allow list";
      } else {
        store.decideGate({ id: parsed.gateId, state: parsed.state, decided_by: who, reason: "" });
        log(`gate ${parsed.gateId} ${parsed.state} by ${who}`);
        applied.push({ id: parsed.gateId, state: parsed.state, decided_by: who });
        toast = toastFor(parsed.state);
        await settle(parsed.gateId, cb, parsed.state, who);
      }

      try {
        await call("answerCallbackQuery", { callback_query_id: cb.id, text: toast });
      } catch {
        // the toast is feedback only; the decision stands without it
      }
    }
    return applied;
  }

  /**
   * Rewrite the posted gate message in place. Used for run progress, so an approved gate shows that the
   * review is working rather than sitting unanswered.
   */
  async function status(gateId, text) {
    const gate = store.getGate(gateId);
    if (!gate?.channel_msg_id) return false;
    try {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: Number(gate.channel_msg_id),
        text: text.length > TELEGRAM_TEXT_LIMIT ? `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}\n…` : text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (error) {
      if (/message is not modified/.test(error.message)) return true;
      throw error;
    }
  }

  /**
   * Put the current controls on messages posted earlier, so a gate that predates a control is not stuck
   * without it. The text is left alone; only the keyboard is rewritten.
   */
  async function refreshControls(gates = store.pendingGates()) {
    let updated = 0;
    for (const gate of gates) {
      if (!gate.kind.endsWith(":telegram") || !gate.channel_msg_id) continue;
      const comments = gate.review_id ? store.commentsFor(gate.review_id) : [];
      const shown = comments.slice(0, telegram.maxFindingButtons);
      const offersRerun = Boolean(gate.review_id) && telegram.rerunButton !== false;
      const keyboard = [decisionRows(gate.id), ...findingRows(gate.id, shown.length), ...(offersRerun ? [rerunRow(gate.id)] : [])];
      try {
        await call("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: Number(gate.channel_msg_id),
          reply_markup: { inline_keyboard: keyboard },
        });
        updated += 1;
      } catch (error) {
        if (/message is not modified/.test(error.message)) continue;
        log(`gate ${gate.id}: its Telegram message could not be updated: ${error.message}`);
      }
    }
    return updated;
  }

  function expire() {
    return expirePending({ cfg, store, log, kindSuffix: ":telegram" });
  }

  /**
   * Rebuilds a message from what the store holds, which fixes a message an earlier build left on the wrong
   * page. A pending gate gets its summary and its full keyboard back; a decided one gets the summary with the
   * result line and no buttons.
   */
  /** One line for the operator with no decision attached: a run that died, a head that got parked. */
  async function notify(text) {
    const sent = await call("sendMessage", {
      chat_id: chatId,
      text: String(text).slice(0, TELEGRAM_TEXT_LIMIT),
      disable_web_page_preview: true,
      disable_notification: false,
    });
    return sent?.message_id ?? null;
  }

  async function redraw(gate) {
    if (!gate?.channel_msg_id) return false;
    const comments = gate.review_id ? store.commentsFor(gate.review_id) : [];
    const shown = comments.slice(0, telegram.maxFindingButtons);
    const offersRerun = Boolean(gate.review_id) && telegram.rerunButton !== false;
    let text = summaryHtml(gate.summary ?? "", { comments: shown, maxFindings: telegram.maxFindingButtons });
    const keyboard = [];
    if (gate.state === "pending") {
      if (offersRerun) text += "\n\n↻ another pass runs a fresh review of this head and supersedes this proposal.";
      keyboard.push(decisionRows(gate.id), ...findingRows(gate.id, shown.length));
      if (offersRerun) keyboard.push(rerunRow(gate.id));
    } else {
      // The reason is what makes a settled gate readable: "withdrawn" on its own does not say the pull
      // request merged out from under the ask.
      text += `\n\n<b>${gate.state}</b>${gate.decided_by ? ` by ${gate.decided_by}` : ""}${gate.reason ? `: ${gate.reason}` : ""}`;
    }
    await call("editMessageText", {
      chat_id: chatId,
      message_id: Number(gate.channel_msg_id),
      text: text.slice(0, TELEGRAM_TEXT_LIMIT),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
    return true;
  }

  return { post, status, refreshControls, readDecisions, expire, call, redraw, notify, releaseLease, leaseHeld, longPollMs: Math.max(0, Number(telegram.longPollSeconds ?? 0)) * 1000 };
}
