/**
 * Admin gate.
 *
 * A decision row in SQLite plus a channel that presents the queued review. Phase 1 ships `none`
 * (post without asking) and `cli` (queue, decide with src/cli/gate.mjs). Slack and Telegram plug into
 * the same interface: present(), then poll for the decision.
 */

export function createGate({ cfg, store, log = () => {}, slack = null }) {
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
     * Open a gate for a composed review.
     * Returns { state: "approved" | "queued" | "skipped", gateId }.
     */
    async open({ stage, reviewId, summary, target = null }) {
      if (!this.requiresApproval(stage)) return { state: "approved", gateId: null };

      const gateId = store.openGate({
        kind: `${stage}:${kind}`,
        review_id: reviewId,
        summary,
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

      if (kind === "slack") {
        if (!slack) {
          log("gate.channel=slack needs Slack tokens; check gate.slack.tokenEnv in config.yaml");
          return { state: "queued", gateId };
        }
        const posted = await slack.post(gateId, summary, { reviewId });
        if (!posted) log(`gate ${gateId} could not be presented in Slack and stays queued`);
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
