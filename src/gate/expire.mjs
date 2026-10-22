/**
 * A gate that nobody answers is held, not forgotten. Shared by the transports so a timeout means the
 * same thing whichever channel presented the review.
 */
export function expirePending({ cfg, store, log = () => {}, kindSuffix = null }) {
  const limit = Date.now() - cfg.gate.timeoutHours * 3600_000;
  const expired = store.pendingGates().filter((gate) => Date.parse(gate.created_at) < limit && (!kindSuffix || gate.kind.endsWith(kindSuffix)));
  for (const gate of expired) {
    store.decideGate({ id: gate.id, state: cfg.gate.onTimeout === "skip" ? "skipped" : "expired", decided_by: "timeout" });
    log(`gate ${gate.id} ${cfg.gate.onTimeout === "skip" ? "skipped" : "expired"} after ${cfg.gate.timeoutHours}h`);
  }
  return expired.length;
}
