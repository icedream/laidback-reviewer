import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfig, secret } from "../../src/config.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

function writeConfig(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, stringify(tree));
  return file;
}

test("defaults fill in the safe values", () => {
  const file = writeConfig({ github: { me: "octocat" }, agent: { model: { provider: "p", id: "m" } } });
  const cfg = loadConfig({ path: file, env: {} });
  assert.equal(cfg.reviews.dryRun, true, "posting must default off");
  assert.equal(cfg.reviews.approve, "hint");
  assert.equal(cfg.reviews.requestChanges, "hint");
  assert.equal(cfg.gate.beforePost, true);
  assert.equal(cfg.gate.slack.seedReactions, "auto", "do not seed a chip the decider would clear");
  assert.equal(cfg.trigger.mode, "review_requested", "an individual review request is the trigger");
  assert.equal(cfg.trigger.policy, "any");
  assert.equal(cfg.trigger.skipDraft, true);
});

test("the old assignment section still works and says what changed", () => {
  const tree = baseConfig({ dir: "/tmp" });
  delete tree.trigger;
  tree.assignment = { policy: "exclude_codeowners", skipDraft: false };
  const cfg = loadConfig({ path: writeConfig(tree), env: {} });

  assert.equal(cfg.trigger.policy, "exclude_codeowners");
  assert.equal(cfg.trigger.skipDraft, false);
  assert.equal(cfg.trigger.mode, "review_requested", "a renamed section does not revive assignment triggering");
  assert.match((cfg._deprecations ?? []).join(" "), /assignment: is now trigger:/);
});

test("trigger wins where both spellings are present", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.trigger = { mode: "assigned", policy: "any" };
  tree.assignment = { policy: "human_actor" };
  const cfg = loadConfig({ path: writeConfig(tree), env: {} });

  assert.equal(cfg.trigger.mode, "assigned");
  assert.equal(cfg.trigger.policy, "any");
});

test("the removed review-request switch is rejected and names its replacement", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.assignment = { includeReviewRequests: true };
  const file = writeConfig(tree);

  assert.throws(() => loadConfig({ path: file, env: {} }), /assignment\.includeReviewRequests: unknown key/);
  assert.throws(() => loadConfig({ path: file, env: {} }), /a review request is the trigger now/);
});

test("the review agent directory can come from the environment", () => {
  const tree = baseConfig({ dir: "/tmp" });
  delete tree.agent.agentDir;
  const cfg = loadConfig({ path: writeConfig(tree), env: { LAIDBACK_AGENT_DIR: "/srv/agents" } });

  assert.equal(cfg.agent.agentDir, "/srv/agents");
});

test("a configured agent directory still beats the environment", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.agent.agentDir = "/pinned/agents";
  const cfg = loadConfig({ path: writeConfig(tree), env: { LAIDBACK_AGENT_DIR: "/srv/agents" } });

  assert.equal(cfg.agent.agentDir, "/pinned/agents");
});

test("the review agent name can come from the environment", () => {
  const tree = baseConfig({ dir: "/tmp" });
  delete tree.agent.name;
  const cfg = loadConfig({ path: writeConfig(tree), env: { LAIDBACK_AGENT_NAME: "review-standard" } });

  assert.equal(cfg.agent.name, "review-standard");
});

test("~ is expanded in the agent paths", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.agent.agentDir = "~/.pi/agent/agents";
  tree.agent.skillsDir = "~/skills";
  const cfg = loadConfig({ path: writeConfig(tree), env: { HOME: "/home/tester" } });

  assert.equal(cfg.agent.agentDir, "/home/tester/.pi/agent/agents");
  assert.equal(cfg.agent.skillsDir, "/home/tester/skills");
});

test("an unknown key is an error, because a dropped key could be a permission", () => {
  const tree = { ...baseConfig({ dir: "/tmp" }), extra: { dangerous: true } };
  const file = writeConfig(tree);
  assert.throws(() => loadConfig({ path: file, env: {} }), /extra: unknown key/);
});

test("an unknown key inside a section names the allowed keys", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.reviews.postApprovals = true; // the old name for reviews.approve
  const file = writeConfig(tree);
  assert.throws(() => loadConfig({ path: file, env: {} }), /reviews\.postApprovals: unknown key/);
});

test("an out-of-range enum is rejected with the allowed values", () => {
  const tree = baseConfig({ dir: "/tmp" });
  tree.reviews.approve = "always";
  const file = writeConfig(tree);
  assert.throws(() => loadConfig({ path: file, env: {} }), /reviews\.approve: must be one of submit, hint, drop/);
});

test("a missing required key fails instead of running with a blank identity", () => {
  const tree = baseConfig({ dir: "/tmp" });
  delete tree.github.me;
  const file = writeConfig(tree);
  assert.throws(() => loadConfig({ path: file, env: {} }), /github\.me: required/);
});

test("secrets stay in the environment and a missing required one fails loudly", () => {
  const tree = baseConfig({ dir: "/tmp" });
  const file = writeConfig(tree);
  const cfg = loadConfig({ path: file, env: { LAIDBACK_TEST_TOKEN: "tok" } });
  assert.equal(secret(cfg, cfg.github.tokenEnv), "tok");
  assert.throws(() => secret(cfg, "LAIDBACK_NOT_SET", { required: true }), /missing environment variable LAIDBACK_NOT_SET/);
});

test("the model provider and id may come from the environment", () => {
  const file = writeConfig({ github: { me: "octocat" } });
  const cfg = loadConfig({ path: file, env: { LAIDBACK_MODEL_PROVIDER: "local/strata", LAIDBACK_MODEL_ID: "qwen3.8-flash-next" } });
  assert.equal(cfg.agent.model.provider, "local/strata");
  assert.equal(cfg.agent.model.id, "qwen3.8-flash-next");
});

test("a model written in the file wins over the environment", () => {
  const file = writeConfig({ github: { me: "octocat" }, agent: { model: { provider: "file-provider", id: "file-model" } } });
  const cfg = loadConfig({ path: file, env: { LAIDBACK_MODEL_PROVIDER: "env-provider", LAIDBACK_MODEL_ID: "env-model" } });
  assert.equal(cfg.agent.model.provider, "file-provider");
  assert.equal(cfg.agent.model.id, "file-model");
});

test("a missing required key names the environment alternative", () => {
  const noMe = writeConfig({ agent: { model: { provider: "p", id: "m" } } });
  assert.throws(() => loadConfig({ path: noMe, env: {} }), /github\.me: required/);

  const noModel = writeConfig({ github: { me: "octocat" } });
  assert.throws(
    () => loadConfig({ path: noModel, env: {} }),
    /agent\.model\.provider and agent\.model\.id may also come from LAIDBACK_MODEL_PROVIDER and LAIDBACK_MODEL_ID/,
  );
});
