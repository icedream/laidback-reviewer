#!/usr/bin/env node
/**
 * Decide a queued review gate from the command line.
 *
 * node src/cli/gate.mjs list
 * node src/cli/gate.mjs show <id>
 * node src/cli/gate.mjs approve <id>
 * node src/cli/gate.mjs reject <id> [reason]
 */

import fs from "node:fs";
import { openStore } from "../proposal/store.mjs";

const STATE_DB = process.env.LAIDBACK_STATE_DB || "data/state.db";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node src/cli/gate.mjs list | show <id> | approve <id> | reject <id> [reason]");
  process.exit(message ? 1 : 0);
}

function main() {
  if (!fs.existsSync(STATE_DB)) usage(`no state database at ${STATE_DB}: the listener has not run yet`);
  const store = openStore(STATE_DB);
  const [command, id, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const pending = store.pendingGates();
    if (!pending.length) console.log("no pending gates");
    for (const gate of pending) console.log(`${gate.id}  ${gate.kind}  ${gate.created_at}  review=${gate.review_id ?? "-"}`);
    return;
  }

  if (!id) usage("a gate id is required");
  const gate = store.getGate(id);
  if (!gate) usage(`no gate ${id}`);

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

  usage(`unknown command ${command}`);
}

main();
