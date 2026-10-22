/** The failure an operator hits first: no review agent file where the config points. */

import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentDef, nonInteractiveContract } from "../../src/agent/agent-def.mjs";

test("a missing agent file names the path and both ways to point elsewhere", () => {
  assert.throws(() => loadAgentDef("/nowhere/agents", "pr-review"), /review agent not found: \/nowhere\/agents\/pr-review\.md/);
  assert.throws(() => loadAgentDef("/nowhere/agents", "pr-review"), /LAIDBACK_AGENT_DIR/);
});

test("the contract keeps the rule about what is already on the PR", () => {
  // Section 9 is about posting, which this harness forbids, but its reading rule still applies: a finding
  // already on the PR is not a new one.
  const text = JSON.stringify(nonInteractiveContract({ cfg: { reviews: { dryRun: true, approve: "hint", requestChanges: "submit" }, agent: {} }, checkoutDir: "/work/x", prRef: { repository: "acme/svc", number: 7 } }));
  assert.match(text, /skip its mechanics and keep its rule/);
  assert.match(text, /do not repeat a finding already on the PR/);
  assert.doesNotMatch(text, /Ignore section 9/);
});
