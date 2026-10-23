/**
 * Stopping the bot without losing the pass in flight.
 *
 * A review can run for ten minutes, and `docker stop` sends SIGTERM with a short grace period. Without a
 * drain the pass dies mid-command and the next start redoes it from nothing. The drain cancels the session
 * instead, which leaves a deferral pointing at the transcript and the scratch tree.
 */

export class ReviewInterruptedError extends Error {
  constructor() {
    super("the bot is stopping");
    this.name = "ReviewInterruptedError";
  }
}

export function createShutdown() {
  let requested = false;
  const hooks = new Set();
  return {
    get requested() {
      return requested;
    },
    onAbort(fn) {
      hooks.add(fn);
      return () => hooks.delete(fn);
    },
    request() {
      if (requested) return 0;
      requested = true;
      for (const fn of hooks) {
        try {
          fn();
        } catch {
          // One hook failing must not keep the process alive for the others.
        }
      }
      return hooks.size;
    },
  };
}
