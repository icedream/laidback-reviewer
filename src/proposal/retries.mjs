/**
 * Retrying a head that failed.
 *
 * A failed run leaves no review row, so a failure that is not recorded is retried on every cycle.
 * Failures are counted per (pr, head) and spaced, and a head that keeps failing is parked.
 */

/** Exponential spacing on attempt n: base * 2^(n-1), capped. */
export function backoffMs({ cfg, attempts }) {
  const grown = cfg.reviews.retryBaseMs * 2 ** (Math.max(1, attempts) - 1);
  return Math.min(cfg.reviews.retryMaxMs, grown);
}

/**
 * Whether this head may be attempted now.
 * @param row the stored failure, or null when the head has never failed
 */
export function failurePlan({ cfg, row, now = new Date() }) {
  if (!row) return { tryNow: true, attempts: 0, reason: "" };
  if (row.parked) {
    return { tryNow: false, parked: true, attempts: row.attempts, reason: `parked after ${row.attempts} failed attempts` };
  }
  const waitMs = new Date(row.next_try_at).getTime() - now.getTime();
  if (waitMs > 0) {
    return {
      tryNow: false,
      attempts: row.attempts,
      waitSeconds: Math.ceil(waitMs / 1000),
      reason: `attempt ${row.attempts} failed (${String(row.last_error ?? "").slice(0, 80)}); retrying in ${Math.ceil(waitMs / 1000)}s`,
    };
  }
  return { tryNow: true, attempts: row.attempts, reason: `retrying after ${row.attempts} failed attempt(s)` };
}

/** Record a failure and return what happens next. */
export function recordFailure({ cfg, store, key, error, now = new Date(), log = () => {} }) {
  const existing = store.getFailure(key);
  const attempts = (existing?.attempts ?? 0) + 1;
  const parked = attempts >= cfg.reviews.maxAttemptsPerHead ? 1 : 0;
  const wait = backoffMs({ cfg, attempts });
  const nextTryAt = new Date(now.getTime() + wait).toISOString();
  const message = String(error?.message ?? error).slice(0, 400);

  store.recordFailure({ ...key, attempts, last_error: message, next_try_at: nextTryAt, parked, now: now.toISOString() });

  if (parked) log(`parked ${key.owner}/${key.repo}#${key.pr} at ${key.head_sha.slice(0, 8)} after ${attempts} attempts: ${message}`);
  else log(`run failed (${message}); retry in ${Math.round(wait / 1000)}s, attempt ${attempts + 1} of ${cfg.reviews.maxAttemptsPerHead}`);

  return { attempts, parked: Boolean(parked), nextTryAt, waitMs: wait };
}

/** A head that produced a review is no longer failing. */
export function clearFailure({ store, key }) {
  store.clearFailure(key);
}

/**
 * One line for the gate channel: what failed, on which head, and what the bot intends to do about it.
 * The operator should not have to read the log to learn a review died.
 */
export function failureNote({ cfg, candidate, error, plan }) {
  const reason = String(error?.message ?? error).slice(0, 200);
  const next = plan.parked
    ? `parked after ${plan.attempts} attempts, nothing more will run for this head`
    : `attempt ${plan.attempts + 1} of ${cfg.reviews.maxAttemptsPerHead} at ${plan.nextTryAt.slice(11, 16)}`;
  return `⚠ ${candidate.htmlUrl ?? `${candidate.owner}/${candidate.repo}#${candidate.pr}`} head ${String(candidate.headSha ?? "").slice(0, 8)}: review failed: ${reason}. ${next}.`;
}
