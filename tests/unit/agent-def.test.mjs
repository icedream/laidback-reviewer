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

test("the contract keeps the runner out of the review text", () => {
  const cfg = { reviews: { dryRun: true, approve: "hint", requestChanges: "submit" }, agent: {}, banner: { mode: "appended", prefix: "", suffix: "" } };
  const text = JSON.stringify(nonInteractiveContract({ cfg, checkoutDir: "/work/x", prRef: { repository: "acme/svc", number: 7 } }));
  assert.match(text, /Name what you ran as evidence only where the run is the finding/);
  assert.match(text, /What stays out of the review is the runner/);
  assert.match(text, /which hosts were unreachable/);
  assert.match(text, /A check you did not do is simply not claimed/);
});

test("the contract keeps a lint run and the author's own caveats out of the body", () => {
  // An example sentence handed over as evidence invites both shapes: a recited tool version, and an
  // answer to a caveat the author wrote about their own change.
  const cfg = { reviews: { dryRun: true, approve: "hint", requestChanges: "submit" }, agent: {}, banner: { mode: "appended", prefix: "", suffix: "" } };
  const text = JSON.stringify(nonInteractiveContract({ cfg, checkoutDir: "/work/x", prRef: { repository: "acme/svc", number: 7 } }));
  assert.doesNotMatch(text, /golangci-lint v2\.12\.2/);
  assert.match(text, /never the version, the/);
  assert.match(text, /What a gate run showed goes to the record, not the body/);
  assert.match(text, /Notes the author wrote in the PR body themselves are their account of the work/);
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

test("a task gate message links the pull request it answers", async () => {
  const { taskGateSummary } = await import("../../src/review-run.mjs");
  const { summaryHtml } = await import("../../src/gate/telegram-format.mjs");
  const summary = taskGateSummary({
    pr: { html_url: "https://github.com/acme/svc/pull/70", repository: "acme/svc", number: 70, title: "fix: govulncheck findings" },
    headSha: "948ed420abcdef0123456789",
  });
  assert.equal(summary.split("\n")[0], "PR: https://github.com/acme/svc/pull/70");
  assert.match(summary, /Review requested for acme\/svc#70 at 948ed420: fix: govulncheck findings/);
  assert.match(summaryHtml(summary, { comments: [], maxFindings: 0 }), /^<a href="https:\/\/github\.com\/acme\/svc\/pull\/70">acme\/svc#70<\/a>$/m);
});
