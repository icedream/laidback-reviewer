/**
 * Retrying a busy inference endpoint.
 *
 * The model server holds one prompt at a time and is shared with interactive sessions. A session that
 * has already read the diff is asked to continue instead of the run starting over.
 */

import { ModelBudgetError, ModelBusyError, watchRun } from "./run-watch.mjs";

const TRANSIENT = /(overload|busy|rate.?limit|\b429\b|\b50[0-4]\b|timed out|timeout|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|socket hang up|connection (error|closed|reset)|server_error|engineovl)/i;

export function isTransientModelError(error) {
  const parts = [error?.message, error?.name, error?.cause?.message, error?.data?.error?.type, error?.type];
  return TRANSIENT.test(parts.filter(Boolean).join(" "));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Prompts the session and returns the number of retries used.
 *
 * Retried: a thrown transient error, and a turn with no findings and no review_submit. A provider
 * that swallows a busy response ends the turn quietly, so an empty collector is the only sign. A turn
 * with findings but no review_submit is not retried: review-run composes from what was recorded.
 */
export async function promptWithModelRetry({ session, cfg, collector, prompt, log = () => {}, sleepImpl = sleep, probe = null }) {
  const { busyRetries, busyBackoffMs, firstTokenMs } = cfg.agent.model;
  const budgetMs = cfg.reviews?.budgetMs ?? 0;

  for (let attempt = 0; ; attempt += 1) {
    const text =
      attempt === 0
        ? prompt
        : "Continue the review: the previous attempt failed with a model error. Pick up where you left off and finish with review_submit.";

    const watch = watchRun({ session, firstTokenMs, budgetMs, probe, log });
    let thrown = null;
    try {
      await session.prompt(text);
    } catch (error) {
      watch.release();
      // A cancelled run aborts inside the provider, and that error is not the interesting part: the
      // reason the watchdog pulled the plug is.
      if (watch.state.busy) throw new ModelBusyError(watch.state.busy);
      if (watch.state.overBudget) throw new ModelBudgetError(budgetMs);
      if (!isTransientModelError(error)) throw error;
      thrown = error;
    }
    watch.release();
    if (watch.state.busy) throw new ModelBusyError(watch.state.busy);
    if (watch.state.overBudget) throw new ModelBudgetError(budgetMs);

    if (collector && !collector.isEmpty()) return attempt;
    if (attempt >= busyRetries) {
      if (thrown) log(`model endpoint still failing after ${attempt} retry(ies): ${thrown.message}`);
      else log(`the model turn produced no review after ${attempt + 1} attempt(s)`);
      if (thrown) throw thrown;
      return attempt;
    }

    log(
      thrown
        ? `model endpoint busy (${thrown.message}); retry ${attempt + 1}/${busyRetries} in ${busyBackoffMs}ms`
        : `the model turn produced no review; continuing the session, retry ${attempt + 1}/${busyRetries} in ${busyBackoffMs}ms`,
    );
    await sleepImpl(busyBackoffMs);
  }
}
