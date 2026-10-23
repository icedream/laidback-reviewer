#!/usr/bin/env node
/**
 * Decide a queued review gate from the command line.
 *
 * node src/cli/gate.mjs list
 * node src/cli/gate.mjs sync
 * node src/cli/gate.mjs show <id>
 * node src/cli/gate.mjs approve <id>
 * node src/cli/gate.mjs reject <id> [reason]
 * node src/cli/gate.mjs hold <id>
 */

import fs from "node:fs";
import { loadConfig } from "../config.mjs";
import { gateTransportFromConfig } from "../gate/transport.mjs";
import { openStore } from "../proposal/store.mjs";
import { requestRerun } from "../gate/gate.mjs";

const STATE_DB = process.env.LAIDBACK_STATE_DB || "data/state.db";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node src/cli/gate.mjs list | sync | show <id> | approve <id> | reject <id> [reason] | hold <id> | rerun <id> | controls | redraw [id] [limit]");
  process.exit(message ? 1 : 0);
}

async function main() {
  if (!fs.existsSync(STATE_DB)) usage(`no state database at ${STATE_DB}: the listener has not run yet`);
  const store = openStore(STATE_DB);
  const [command, id, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const pending = store.pendingGates();
    if (!pending.length) console.log("no pending gates");
    for (const gate of pending) console.log(`${gate.id}  ${gate.kind}  ${gate.created_at}  review=${gate.review_id ?? "-"}`);
    return;
  }

  if (command === "sync") {
    // A decision taken in Slack only reaches the store when someone reads the thread back. Without the
    // poll loop running, this is what turns a reaction into an approval that post-approved can act on.
    const cfg = loadConfig();
    const transport = gateTransportFromConfig({ cfg, store, log: (line) => console.log(line) });
    if (!transport) usage(`sync reads the gate channel: gate.channel=${cfg.gate.channel} needs its credentials, e.g. gate.telegram.botTokenEnv and gate.telegram.chatIdEnv`);
    const applied = await transport.readDecisions();
    if (!applied.length) console.log("no new decisions in the gate threads");
    for (const gate of applied) console.log(`gate ${gate.id} -> ${gate.state} by ${gate.decided_by}${gate.reason ? ` (${gate.reason})` : ""}`);
    return;
  }

  // These work over every gate the bot holds, so they are the commands that do not need an id.
  const needsGate = !["list", "sync", "controls", "redraw"].includes(command);
  const gate = needsGate ? store.getGate(id) : null;
  if (needsGate && !gate) usage(id ? `no gate ${id}` : "a gate id is required");

  if (command === "show") {
    console.log(gate.summary);
    return;
  }

  if (command === "approve" || command === "reject") {
    const decided = store.decideGate({
      id,
      state: command === "approve" ? "approved" : "rejected",
      decided_by: process.env.USER ?? "cli",
      reason: rest.join(" ") || null,
    });
    console.log(`gate ${id} → ${decided.state}${decided.reason ? ` (${decided.reason})` : ""}`);
    if (command === "approve" && decided.review_id) {
      console.log(`review ${decided.review_id} is approved; post it with: node src/cli/post-approved.mjs ${decided.review_id}`);
    }
    return;
  }

  if (command === "controls") {
    const cfg = loadConfig();
    const transport = gateTransportFromConfig({ cfg, store, log: (line) => console.log(line) });
    if (!transport?.refreshControls) usage("only the slack and telegram channels post messages with controls to refresh");
    const refreshed = await transport.refreshControls();
    console.log(`${refreshed} waiting gate message(s) brought up to date`);
    process.exit(0);
  }

  if (command === "redraw") {
    // Rebuilds gate messages from the store, which puts right a message an earlier build left on a finding
    // page. Pass an id to fix one message, nothing to fix every message the bot still holds.
    const cfg = loadConfig();
    const transport = gateTransportFromConfig({ cfg, store, log: (line) => console.log(line) });
    if (!transport?.redraw) usage("redraw rewrites the channel's messages: it needs gate.channel configured, and a channel that can edit messages");
    const gates = id ? [store.getGate(id)].filter(Boolean) : store.gatesWithMessages({ limit: Number(rest[0] ?? 100) });
    let done = 0;
    for (const gate of gates) {
      try {
        if (await transport.redraw(gate)) {
          done += 1;
          console.log(`gate ${gate.id} ${gate.state} redrawn on message ${gate.channel_msg_id}`);
        }
      } catch (error) {
        console.error(`gate ${gate.id} could not be redrawn: ${error.message}`);
      }
    }
    console.log(`${done} gate message(s) redrawn`);
    return;
  }

  if (command === "rerun") {
    // Works on a gate whose message has no rerun control, which is every gate posted before it existed.
    const asked = requestRerun({ store, gate, by: process.env.USER ? `cli:${process.env.USER}` : "cli", log: console.log });
    if (!asked) usage(`gate ${id} records no repository and head, so there is nothing to re-run`);
    console.log(`another pass over ${gate.owner}/${gate.repo}#${gate.pr} at ${gate.head_sha.slice(0, 8)} is queued for the next cycle`);
    process.exit(0);
  }

  if (command === "hold") {
    // Same meaning as `hold <id>` in Slack: leave the gate alone, post nothing.
    console.log(`gate ${id} stays ${gate.state}; nothing is posted, and it expires after gate.timeoutHours if nobody decides it`);
    return;
  }

  usage(`unknown command ${command}`);
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
