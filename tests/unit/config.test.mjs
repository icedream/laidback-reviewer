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
  assert.equal(cfg.gate.onTimeout, "hold");
  assert.equal(cfg.assignment.policy, "any");
  assert.equal(cfg.assignment.includeReviewRequests, false);
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
