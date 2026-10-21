/**
 * Git auth for self-started checkouts. In clone mode this runs before any repository exists, so it has
 * to configure what it can and skip what it cannot.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureGitAuth, credentialHelperArgs } from "../../src/checkout.mjs";

test("the helper is two arguments and names the variable, never the token", () => {
  const [flag, assignment] = credentialHelperArgs("LAIDBACK_GH_TOKEN");

  assert.equal(flag, "-c");
  assert.match(assignment, /^credential\.helper=/);
  assert.match(assignment, /\$LAIDBACK_GH_TOKEN/);
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-gitauth-"));
  const cfg = {
    github: { tokenEnv: "LAIDBACK_GH_TOKEN" },
    checkout: { gitConfig: path.join(dir, "gitconfig") },
  };
  return { dir, cfg };
}

test("a directory that is not a repository yet leaves the global config in place", () => {
  const { dir, cfg } = scratch();
  const missing = path.join(dir, "repos", "example", "svc");

  configureGitAuth({ cfg, dir: missing, log: () => {} });

  const written = fs.readFileSync(cfg.checkout.gitConfig, "utf8");
  assert.match(written, /\[credential\]/);
  assert.match(written, /insteadOf = git@github.com:/);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, cfg.checkout.gitConfig);
});

test("an existing repository also gets the local settings", () => {
  const { dir, cfg } = scratch();
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);

  configureGitAuth({ cfg, dir: repo, log: () => {} });

  const helper = execFileSync("git", ["config", "--local", "credential.helper"], { cwd: repo, encoding: "utf8" }).trim();
  assert.match(helper, /LAIDBACK_GH_TOKEN/);
});
