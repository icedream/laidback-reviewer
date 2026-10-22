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

test("a gitconfig left over from an older run is repaired, not kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-gitauth-stale-"));
  const file = path.join(dir, "gitconfig");
  // What an earlier version wrote: the key kept in the value, so git execs a helper named after it.
  fs.writeFileSync(file, "[credential]\n\thelper = credential.helper=!f(){ echo username=x; };f\n");
  try {
    configureGitAuth({ cfg: { github: { tokenEnv: "LAIDBACK_GH_TOKEN" }, checkout: { gitConfig: file } }, log() {} });
    const written = fs.readFileSync(file, "utf8");
    assert.match(written, /helper = "!f\(\)/, "the value is the quoted command, not key=value");
    assert.ok(!/helper = credential\.helper=/.test(written));
    const [, helperValue] = credentialHelperArgs("LAIDBACK_GH_TOKEN");
    const helper = helperValue.replace(/^credential\.helper=/, "");
    assert.ok(written.includes(`"${helper}"`), "the helper is quoted, or git reads the ; as a comment");

    // What the repository's own Makefile and `go mod download` see: git's parser, not our writer.
    process.env.LAIDBACK_GH_TOKEN = "probe-token";
    const filled = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_TERMINAL_PROMPT: "0" },
    });
    assert.match(filled, /username=x-access-token/);
    assert.match(filled, /password=probe-token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
