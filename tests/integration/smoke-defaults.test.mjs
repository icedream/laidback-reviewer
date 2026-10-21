/**
 * The live smoke runner must refuse to guess a model provider.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "tests", "integration", "live-smoke.mjs");

test("without a provider it stops and says what to set", () => {
  const env = { ...process.env };
  delete env.LAIDBACK_MODEL_PROVIDER;

  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No model provider for the smoke run/);
  assert.match(run.stderr, /LAIDBACK_MODEL_PROVIDER|--provider <provider>/);
});

test("the provider can come from the environment", () => {
  const run = spawnSync(process.execPath, [SCRIPT, "--provider", "smoke-probe", "--model", "smoke-model"], {
    env: { ...process.env, LAIDBACK_MODEL_PROVIDER: undefined },
    encoding: "utf8",
    timeout: 20_000,
  });
  // It gets past the provider check and fails later, on a provider that does not exist.
  assert.doesNotMatch(run.stderr, /No model provider for the smoke run/);
});
