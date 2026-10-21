/**
 * A review run against a repository that pins its linter.
 *
 * The fixture pins v2.15.0 in its CI env and Makefile, and its config file declares the v2 schema, so
 * the harness should install that release into its own tools dir and tell the agent which binary to
 * use. A fetch that fails must not cost the review.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupReviewRun } from "../helpers/run-env.mjs";

/** Serves a tarball in the shape of a golangci-lint release. */
function fakeReleaseServer() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-rel-"));
  const inner = "golangci-lint-2.15.0-linux-amd64";
  fs.mkdirSync(path.join(stage, inner, "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, inner, "bin", "golangci-lint"), "#!/bin/sh\necho golangci-lint version v2.15.0\n", { mode: 0o755 });
  const archive = path.join(stage, "release.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, inner]);

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(fs.readFileSync(archive));
  });
  return {
    requests,
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => {
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}

const promptText = (env) => JSON.stringify(env.model.requests()[0]?.messages ?? []);

test("the pinned linter is installed and named in the task prompt", async () => {
  const server = fakeReleaseServer();
  const downloadBaseUrl = await server.start();
  const env = await setupReviewRun({ overrides: { toolchain: { golangciLint: "auto", downloadBaseUrl } } });
  try {
    const result = await env.run();
    assert.ok(result.composed.verdict);

    const installed = path.join(env.dir, "tools", "golangci-lint", "v2.15.0", "bin", "golangci-lint");
    assert.ok(fs.existsSync(installed), `expected the pinned release at ${installed}`);
    assert.deepEqual(server.requests, ["/golangci/golangci-lint/releases/download/v2.15.0/golangci-lint-2.15.0-linux-amd64.tar.gz"]);

    const prompt = promptText(env);
    assert.match(prompt, /Linting\. This repository pins golangci-lint v2\.15\.0 in \.github\/workflows\/ci\.yml/);
    assert.match(prompt, /config \.golangci\.yml declares schema version 2/);
    assert.ok(prompt.includes(`Use ${installed} for the lint gate`), "the prompt names the binary the harness installed");
    assert.match(prompt, /tooling gap: record the gate as not_run/);
    assert.doesNotMatch(prompt, /The pins disagree/);
  } finally {
    env.close();
    server.close();
  }
});

test("a linter that cannot be fetched is recorded as tooling, not as a defect", async () => {
  const env = await setupReviewRun({
    overrides: { toolchain: { golangciLint: "auto", downloadBaseUrl: "http://127.0.0.1:1" } },
  });
  try {
    const result = await env.run();
    assert.ok(result.composed.verdict, "the review still composes");

    assert.match(promptText(env), /Tooling note: could not install v2\.15\.0/);
    const row = env.store.reviewFor({ owner: "example", repo: "orders-svc", pr: env.fixture.pr, head_sha: env.fixture.head.sha });
    const notes = JSON.parse(row.notes ?? "[]");
    assert.ok(notes.some((note) => note.startsWith("lint tooling: could not install")), `notes: ${notes.join(" | ")}`);
  } finally {
    env.close();
  }
});

test("toolchain.golangciLint=off leaves the linter alone", async () => {
  const env = await setupReviewRun();
  try {
    await env.run();
    const prompt = promptText(env);
    assert.doesNotMatch(prompt, /Linting\./);
    assert.equal(fs.existsSync(path.join(env.dir, "tools")), false, "nothing is installed when the toolchain is off");
  } finally {
    env.close();
  }
});
