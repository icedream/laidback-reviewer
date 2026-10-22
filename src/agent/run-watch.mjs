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
 * Returns { state, release }. state.busy is set when the watchdog cancelled the run because the server
 * was occupied; state.overBudget when the whole-run budget fired. Call release() once the prompt is
 * done, or the timers outlive the turn.
 */
export function watchRun({ session, firstTokenMs = 45_000, budgetMs = 0, probe = null, log = () => {}, timer = setTimeout, untimer = clearTimeout }) {
  const state = { activity: false, busy: null, overBudget: false };
  const unsubscribe = typeof session.subscribe === "function" ? session.subscribe((event) => ACTIVITY.has(event?.type) ? (state.activity = true) : undefined) : () => {};

  const cancel = async (why) => {
    try {
      await session.abort?.();
    } catch (error) {
      log(`aborting the run did not settle: ${error.message}`);
    }
  };

  const firstTokenTimer = probe
    ? timer(async () => {
        if (state.activity) return;
        let status = null;
        try {
          status = await probe();
        } catch {
          return;
        }
        if (!status?.busy) return;
        state.busy = status;
        log(`no model output in ${firstTokenMs}ms while the server shows ${status.phase || "a prompt in flight"}: cancelling the request`);
        await cancel("first token");
      }, firstTokenMs)
    : null;

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
      if (firstTokenTimer) untimer(firstTokenTimer);
      if (budgetTimer) untimer(budgetTimer);
      unsubscribe();
    },
  };
}
