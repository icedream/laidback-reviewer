/**
 * Every outbound call has a deadline.
 *
 * A review that hangs is worse than a review that fails: it holds the inference slot, the worktree and
 * the cycle, and it says nothing. These are the bounds that make a stall a recorded outcome.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitExecOptions } from "../../src/checkout.mjs";
import { createGithubClient } from "../../src/github/client.mjs";
import { ensureGolangciLint } from "../../src/tools/golangci-lint.mjs";

const abortOnSignal = (_url, options) =>
  new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

test("git never waits for a terminal and never transfers forever", () => {
  const cfg = { checkout: { commandTimeoutMs: 5_000, transferTimeoutMs: 600_000 } };
  const quick = gitExecOptions(cfg);
  const transfer = gitExecOptions(cfg, { long: true });

  assert.equal(quick.timeout, 5_000);
  assert.equal(transfer.timeout, 600_000);
  assert.equal(quick.env.GIT_TERMINAL_PROMPT, "0", "a credential prompt would hang the whole cycle");
  assert.equal(Number(quick.env.GIT_HTTP_LOW_SPEED_LIMIT) > 0, true);
  assert.equal(Number(quick.env.GIT_HTTP_LOW_SPEED_TIME) > 0, true);
});

test("a github request that never answers is cut off with the call named", async () => {
  const client = createGithubClient({ baseUrl: "http://127.0.0.1:1", token: "t", timeoutMs: 40, fetchImpl: abortOnSignal, log: () => {} });

  await assert.rejects(() => client.getPull("acme", "svc", 7), /github api answered nothing within 40ms: GET \/repos\/acme\/svc\/pulls\/7/);
});

test("a stalled linter download reports the URL and leaves nothing behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-download-timeout-"));
  try {
    const cfg = {
      toolchain: { installDir: dir, downloadBaseUrl: "https://github.com", downloadTimeoutMs: 40, execTimeoutMs: 1_000 },
      tools: { allowHosts: ["github.com", "objects.githubusercontent.com"] },
    };

    await assert.rejects(() => ensureGolangciLint({ cfg, version: "v2.15.0", fetchImpl: abortOnSignal, log: () => {} }), /could not fetch https:\/\/github\.com\/golangci\/golangci-lint\/releases\/download\/v2\.15\.0\//);
    assert.equal(fs.existsSync(path.join(dir, "golangci-lint", "v2.15.0")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
