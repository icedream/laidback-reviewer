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

test("the contract tells the review which notice opens and which closes", () => {
  const cfg = { reviews: { dryRun: true, approve: "hint", requestChanges: "submit" }, agent: {}, banner: { mode: "authored", prefix: "I am on leave this week, the bot answers meanwhile.", suffix: "Reply in the thread if you would like a human to look again." } };
  const text = JSON.stringify(nonInteractiveContract({ cfg, checkoutDir: "/work/x", prRef: { repository: "acme/svc", number: 7 } }));
  assert.match(text, /opening line, before your findings:/);
  assert.match(text, /I am on leave this week, the bot answers meanwhile/);
  assert.match(text, /closing line, after your findings:/);
  assert.match(text, /two different notices: one introduces the review, the other closes it/);
  assert.match(text, /checked only there/);

  // With one notice configured there is nothing to contrast, so no second-notice sentence.
  const only = { ...cfg, banner: { ...cfg.banner, suffix: "" } };
  const single = JSON.stringify(nonInteractiveContract({ cfg: only, checkoutDir: "/work/x", prRef: { repository: "acme/svc", number: 7 } }));
  assert.doesNotMatch(single, /two different notices/);
  assert.match(single, /opening line, before your findings:/);
  assert.doesNotMatch(single, /closing line, after your findings:/);
});
