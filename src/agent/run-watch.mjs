/**
 * Cancelling a prompt that is stuck behind another client.
 *
 * The server will not tell a queued request its place, and it keeps reading a prompt body from a client
 * that has stopped sending one. So the harness watches its own run: nothing on the wire after a while,
 * and the server busy elsewhere, means the request is cancelled and the review is deferred. A slow
 * first token on an idle server is left alone, because that is a large prompt rather than a queue.
 */

export class ModelBusyError extends Error {
  constructor(status) {
    super(`model server busy (${status?.phase || status?.source || "unknown"})`);
    this.name = "ModelBusyError";
    this.status = status;
  }
}

export class ModelBudgetError extends Error {
  constructor(budgetMs) {
    super(`review run exceeded its ${Math.round(budgetMs / 1000)}s budget`);
    this.name = "ModelBudgetError";
    this.budgetMs = budgetMs;
  }
}

const ACTIVITY = new Set(["message_start", "message_update", "message_end", "tool_execution_start", "turn_end"]);

/**
 * Why a silent run should be cancelled, or nothing when the server is merely working.
 */
export function cancellationReason(previous, status) {
  if (!status) return "";
  if (Number(status.queued ?? 0) > 0) return `${status.queued} request(s) are queued in front of us`;
  // An idle server with a silent run is our own side between requests: the tool results are being
  // assembled and the next prompt has not gone out yet. Frozen counters say nothing in that case.
  if (status.busy === false) return "";
  const counts = typeof status.generated === "number" && typeof status.promptTokens === "number";
  // A prefill moves neither counter: the prompt size is published up front and nothing is generated yet,
  // so a large fork looks frozen for minutes. Only a server that had begun producing for us and stopped
  // says the work is not ours.
  const producing = Number(status.generated) > 0 || /thinking|writing|generat/i.test(String(status.phase ?? ""));
  if (counts && producing && previous && previous.generated === status.generated && previous.promptTokens === status.promptTokens) {
    return `the server has produced nothing since ${status.phase || "its last state"}`;
  }
  return "";
}

/**
 * Returns { state, release }. state.busy is set when the watchdog cancelled the run because the server
 * was occupied; state.overBudget when the whole-run budget fired. Call release() once the prompt is
 * done, or the timers outlive the turn.
 *
 * The check is a staleness rule rather than a one-shot deadline: a review makes many model requests, and
 * a queue can form in front of any of them, so silence is measured from the last event of any kind. What
 * counts as stalled is a queue in front of us, or generation that started and froze; a long prefill and a
 * server between our own requests are both left alone, and the whole-run budget is the backstop there.
 */
export function watchRun({ session, firstTokenMs = 45_000, budgetMs = 0, probe = null, log = () => {}, timer = setTimeout, untimer = clearTimeout, now = () => Date.now() }) {
  const startedAt = now();
  const state = { activity: false, busy: null, reason: "", overBudget: false, lastActivityAt: startedAt, checks: 0 };
  const unsubscribe =
    typeof session.subscribe === "function"
      ? session.subscribe((event) => {
          if (event?.type === "turn_start") state.activity = false;
          else if (ACTIVITY.has(event?.type)) state.activity = true;
          else return;
          state.lastActivityAt = now();
        })
      : () => {};

  const intervalMs = Math.max(1_000, Math.min(firstTokenMs, 5_000));

  const cancel = async (why) => {
    try {
      await session.abort?.();
    } catch (error) {
      log(`aborting the run did not settle: ${error.message}`);
    }
  };

  let armed = null;
  let previous = null;
  const tick = async () => {
    const silence = now() - state.lastActivityAt;
    state.checks += 1;
    if (silence >= firstTokenMs) {
      let status = null;
      try {
        status = await probe();
      } catch {
        status = null;
      }
      // Silence alone proves nothing: a local model writing a long answer is silent too. Two reasons
      // cancel, and both say the work is not ours: something is queued in front of us, or the server's
      // own counters have not moved between two looks, which is a client that stopped sending.
      const reason = cancellationReason(previous, status);
      if (reason) {
        state.busy = status;
        state.reason = reason;
        log(`nothing on the wire for ${Math.round(silence / 1000)}s and ${reason}: cancelling the request`);
        await cancel("silence");
        return;
      }
      previous = status;
    }
    armed = timer(tick, intervalMs);
  };

  armed = probe ? timer(tick, intervalMs) : null;

  const budgetTimer = budgetMs
    ? timer(async () => {
        state.overBudget = true;
        log(`review run passed ${Math.round(budgetMs / 1000)}s: cancelling it`);
        await cancel("budget");
      }, budgetMs)
    : null;

  return {
    state,
    release() {
      if (armed) untimer(armed);
      if (budgetTimer) untimer(budgetTimer);
      unsubscribe();
    },
  };
}
