/**
 * Progress on the gate message while a review runs.
 *
 * An approved task gate otherwise sits in the chat unchanged for ten minutes, which looks identical to a
 * hang. The session already reports its phase, tool calls and tokens, so the cost of showing that is a
 * throttled edit of the message the decision was made on.
 */

import { elapsedLabel } from "./progress.mjs";

const escape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param send asynchronous (text) => void, the transport's status writer
 * @param title first line, usually "Reviewing owner/repo#7"
 * @param everyMs minimum gap between rewrites; terminal states ignore it
 * @param budgetMs the wall clock one review may take, shown so a slow run reads as slow rather than stuck
 */
export function createRunStatus({ send, title, everyMs = 20_000, budgetMs = 0, log = () => {}, now = () => Date.now(), startedAt = now() }) {
  let stage = "starting";
  let note = "";
  let lastSentAt = 0;
  let lastText = "";
  let closed = false;

  function render(state = {}) {
    const lines = [`<b>${escape(title)}</b>`];
    if (note) lines.push(escape(note));
    lines.push("");
    lines.push(`Now: ${escape(stage)}`);
    const counters = [];
    if (state.toolCalls) counters.push(`${state.toolCalls} tool call(s)`);
    if (state.tokens) counters.push(`${Math.round(state.tokens / 100) / 10}k tokens`);
    if (counters.length) lines.push(escape(counters.join(", ")));
    const budget = budgetMs ? ` of ${elapsedLabel(startedAt + budgetMs, startedAt)}` : "";
    lines.push(escape(`elapsed ${elapsedLabel(now(), startedAt)}${budget}`));
    return lines.join("\n");
  }

  async function push(text, { force = false } = {}) {
    if (closed || text === lastText) return;
    if (!force && now() - lastSentAt < everyMs) return;
    lastSentAt = now();
    lastText = text;
    try {
      await send(text);
    } catch (error) {
      // A lost status write must not end a review that is running fine.
      log(`status update failed: ${error.message}`);
    }
  }

  return {
    /** One line of context under the title, e.g. the head or the branch. */
    note(text) {
      note = text;
      return push(render());
    },
    setStage(text, state) {
      stage = text;
      return push(render(state));
    },
    /** Called from the progress subscriber, so the message moves as the session works. */
    progress(state) {
      if (state?.phase) stage = state.phase;
      return push(render(state));
    },
    /** The last word on this message: always sent, and nothing after it is. */
    finish(text, detail = "") {
      const lines = [`<b>${escape(text)}</b>`];
      if (detail) lines.push(escape(detail));
      lines.push(escape(`elapsed ${elapsedLabel(now(), startedAt)}${budgetMs ? ` of ${elapsedLabel(startedAt + budgetMs, startedAt)}` : ""}`));
      const sent = push(lines.join("\n"), { force: true });
      closed = true;
      return sent;
    },
  };
}
