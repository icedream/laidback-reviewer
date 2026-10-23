/**
 * Admin gate.
 *
 * A decision row in SQLite plus a channel that presents the queued review. Phase 1 ships `none`
 * (post without asking) and `cli` (queue, decide with src/cli/gate.mjs). Slack and Telegram plug into
 * the same interface: present(), then poll for the decision.
 */

/**
 * Which ask a head is waiting on. A gate answers the review request it was opened for, recorded as that
 * event's timestamp: the same request never gates a head twice, and a newer request is a fresh ask even
 * where an older one was rejected. `askedAt` empty means the request is unknown, so only the state counts.
 */
/**
 * Ask for a fresh pass over a head that has already been reviewed.
 *
 * A composed review sitting on a post gate is rejected as superseded by the same tap: the alternative is
 * a posted review plus a second pass nobody asked to hold. The request outlives a busy inference server,
 * because the loop only consumes it once a pass actually ran.
 */
export function requestRerun({ store, gate, by, log = () => {} }) {
  if (!gate?.owner || !gate?.head_sha) return null;
  store.requestRerun({ owner: gate.owner, repo: gate.repo, pr: gate.pr, head_sha: gate.head_sha, requested_by: by, gate_id: gate.id });
  // Every post gate on this head that could still be approved: a pass held back yesterday would otherwise
  // post next to the one being asked for now, and the older one is the one nobody would defend.
  for (const held of store.gatesForHead({ owner: gate.owner, repo: gate.repo, pr: gate.pr, head_sha: gate.head_sha, stage: "before_post" })) {
    if (held.state !== "pending" && held.state !== "held") continue;
    store.decideGate({ id: held.id, state: "rejected", decided_by: by, reason: "superseded by another pass" });
    if (held.id !== gate.id) log(`gate ${held.id} (${held.state}) rejected: superseded by another pass`);
  }
  log(`gate ${gate.id}: another pass requested for ${gate.owner}/${gate.repo}#${gate.pr} at ${gate.head_sha.slice(0, 8)} by ${by}`);
  return gate;
}

export function taskGateDecision(prior, askedAt = "") {
  if (!prior) return { kind: "none", proceed: false };
  if (askedAt && (!prior.request_ts || prior.request_ts < askedAt)) return { kind: "re-requested", proceed: false };
  if (prior.state === "approved" && !prior.consumed_at) return { kind: "approved", proceed: true, gateId: prior.id };
  if (prior.state === "approved") return { kind: "consumed", proceed: false, gateId: prior.id };
  return { kind: prior.state, proceed: false, gateId: prior.id };
}

export function createGate({ cfg, store, log = () => {}, transport = null }) {
  const kind = cfg.gate.channel;

  return {
    channel: kind,

    /** True when a review must wait for a human before it is sent. */
    requiresApproval(stage) {
      if (cfg.reviews.dryRun) return false;
      if (stage === "before_review") return cfg.gate.beforeReview;
      if (stage === "before_post") return cfg.gate.beforePost;
      return false;
    },

    /**
     * What the task gate for this head already says, so an approval releases the head instead of being
     * read and forgotten. `requestedAt` is the review request that reopened it, which can overrule an
     * older rejection.
     */
    priorDecision({ stage, target, askedAt = "" }) {
      return taskGateDecision(store.latestGateFor({ ...target, stage }), askedAt);
    },

    /**
     * Open a gate for a composed review.
     * Returns { state: "approved" | "queued" | "skipped", gateId }.
     */
    async open({ stage, reviewId, summary, target = null, requestTs = null }) {
      if (!this.requiresApproval(stage)) return { state: "approved", gateId: null };

      const gateId = store.openGate({
        kind: `${stage}:${kind}`,
        review_id: reviewId,
        summary,
        request_ts: requestTs,
        ...(target ?? {}),
      });

      if (kind === "none") return { state: "approved", gateId };

      // A backlog arrives as one message, not five: reviews over the ceiling still queue in the
      // database and are decided from there.
      const pending = store.pendingGates();
      if (pending.length > cfg.gate.maxPending) {
        log(`gate queue holds ${pending.length} of ${cfg.gate.maxPending}; gate ${gateId} is queued without a new presentation`);
        return { state: "queued", gateId, queueFull: true };
      }

      if (kind === "cli") {
        log(`gate ${gateId} (${stage}) is queued; decide with: node src/cli/gate.mjs ${gateId} approve`);
        log(summary);
        return { state: "queued", gateId };
      }

      if (kind === "slack" || kind === "telegram") {
        if (!transport) {
          log(`gate.channel=${kind} needs its credentials; check gate.${kind} in config.yaml`);
          return { state: "queued", gateId };
        }
        const posted = await transport.post(gateId, summary, { reviewId });
        if (!posted) log(`gate ${gateId} could not be presented in ${kind} and stays queued`);
        return { state: "queued", gateId };
      }

      log(`gate channel '${kind}' has no adapter yet; review stays queued`);
      return { state: "queued", gateId };
    },

    decide({ gateId, state, decidedBy, reason }) {
      return store.decideGate({ id: gateId, state, decided_by: decidedBy, reason });
    },

    pending() {
      return store.pendingGates();
    },

    /** Whether a queued gate has been approved since it opened. */
    approved(gateId) {
      if (!gateId) return true;
      const gate = store.getGate(gateId);
      return gate?.state === "approved";
    },
  };
}

export function inlineCommentPosition(comment) {
  return `${comment.path}:${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}`;
}

/** What a thread reply carries: the position, then the finding itself. */
export function renderInlineComment(comment) {
  return `${inlineCommentPosition(comment)}\n${String(comment.body ?? "").trim()}`;
}

const firstLine = (text, limit) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export function renderGateSummary({ pr, headSha, composed, notes, decisions }) {
  const lines = [
    `PR: ${pr.html_url}`,
    `Head: ${headSha}`,
    `Model verdict: ${composed.verdict} → policy action: ${composed.action} → GitHub event: ${composed.event}`,
    `Decisions: ${decisions.join("; ")}`,
    "",
    "Review body:",
    composed.payload.body || "(empty body)",
    "",
    `Inline comments (${composed.payload.comments.length}):`,
    ...composed.payload.comments.map((comment) => `  ${inlineCommentPosition(comment)}${comment.note ? ` (${comment.note})` : ""} — ${firstLine(comment.body, 110)}`),
  ];
  if (notes.length) {
    lines.push("", "Harness notes:", ...notes.map((note) => `  - ${note}`));
  }
  return lines.join("\n");
}
