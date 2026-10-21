/**
 * Reading a repository's linter pins, and fetching the release it asks for.
 *
 * A repository whose CI pins a v1 linter while its config file declares the v2 schema cannot start the
 * linter at all. A review that reports "lint fails" there is blaming the branch.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectConfigSchemaMajor, detectLintPins, ensureGolangciLint, planLint, releaseUrl } from "../../src/tools/golangci-lint.mjs";

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-lint-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const cfgFor = (dir, overrides = {}) => ({
  toolchain: { golangciLint: "auto", installDir: path.join(dir, "tools"), preferRepoVersion: true, downloadBaseUrl: "https://github.com", ...overrides.toolchain },
  tools: { allowHosts: ["127.0.0.1", "github.com", ...(overrides.tools?.allowHosts ?? [])] },
});

test("a CI pin and a Makefile pin are both read, CI first", () => {
  const dir = tree({
    ".github/workflows/ci.yml": `name: ci\njobs:\n  go:\n    env:\n      GOLANGCI_LINT_VERSION: v2.15.0\n    steps:\n      - uses: golangci/golangci-lint-action@v6\n        with:\n          version: v2.15.0\n`,
    Makefile: "GOLANGCI_LINT_VERSION ?= v2.14.0\n\nlint:\n\tgolangci-lint run\n",
    ".golangci.yml": 'version: "2"\nlinters:\n  default: standard\n',
  });
  try {
    const found = detectLintPins(dir);
    assert.equal(found.chosen.version, "v2.15.0");
    assert.match(found.chosen.source, /\.github\/workflows\/ci\.yml/);
    assert.deepEqual(found.pins.map((pin) => pin.version), ["v2.15.0", "v2.15.0", "v2.14.0"]);
    assert.deepEqual(detectConfigSchemaMajor(dir), { major: "2", source: ".golangci.yml" });
    // Different pins is a conflict even when all of them are loadable.
    assert.equal(found.conflict, true);
    assert.deepEqual(found.incompatible, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a v1 pin against a v2 config is named as the problem", () => {
  const dir = tree({
    ".github/workflows/ci.yml": "name: ci\njobs:\n  go:\n    env:\n      GOLANGCI_LINT_VERSION: v1.62.2\n",
    ".golangci.yml": 'version: "2"\n',
  });
  try {
    const found = detectLintPins(dir);
    assert.equal(found.chosen.version, "v1.62.2");
    assert.equal(found.conflict, true);
    assert.deepEqual(found.incompatible, ["v1.62.2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("version managers and a bare Makefile are read too", () => {
  const viaManager = tree({ ".tool-versions": "golangci-lint v2.11.4\nnodejs 24.7.0\n" });
  const viaMise = tree({ ".mise.toml": "[tools]\ngolangci-lint = \"2.13.0\"\n" });
  const viaMake = tree({ Makefile: "GOLANGCI_LINT_VERSION ?= v2.12.1\n" });
  const nothing = tree({ "main.go": "package main\n" });
  try {
    assert.equal(detectLintPins(viaManager).chosen.version, "v2.11.4");
    assert.equal(detectLintPins(viaMise).chosen.version, "v2.13.0");
    assert.equal(detectLintPins(viaMake).chosen.version, "v2.12.1");
    assert.deepEqual(detectLintPins(nothing), { pins: [], chosen: null, configSchema: null, conflict: false, incompatible: [] });
  } finally {
    for (const dir of [viaManager, viaMise, viaMake, nothing]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan decides between the image, an install, and leaving it alone", () => {
  const pinned = tree({ ".golangci.yml": 'version: "2"\n', Makefile: "GOLANGCI_LINT_VERSION ?= v2.15.0\n" });
  const bare = tree({ "main.go": "package main\n" });
  try {
    assert.deepEqual(
      { mode: planLint({ cfg: cfgFor(pinned, { toolchain: { golangciLint: "off" } }), dir: pinned }).mode, version: null },
      { mode: "off", version: null },
    );

    const auto = planLint({ cfg: cfgFor(pinned), dir: pinned });
    assert.equal(auto.mode, "install");
    assert.equal(auto.version, "v2.15.0");
    assert.match(auto.source, /Makefile/);

    const explicit = planLint({ cfg: cfgFor(bare, { toolchain: { golangciLint: "v2.3.1" } }), dir: bare });
    assert.equal(explicit.mode, "install");
    assert.equal(explicit.version, "v2.3.1");
    assert.equal(explicit.source, "toolchain.golangciLint");

    const noPin = planLint({ cfg: cfgFor(bare), dir: bare });
    assert.equal(noPin.mode, "image");
    assert.equal(noPin.version, null);

    const imageWins = planLint({ cfg: cfgFor(pinned, { toolchain: { preferRepoVersion: false } }), dir: pinned });
    assert.equal(imageWins.mode, "image");
  } finally {
    for (const dir of [pinned, bare]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the release asset name follows the published layout", () => {
  assert.equal(
    releaseUrl({ downloadBaseUrl: "https://github.com", version: "v2.15.0", platform: "linux", arch: "x64" }),
    "https://github.com/golangci/golangci-lint/releases/download/v2.15.0/golangci-lint-2.15.0-linux-amd64.tar.gz",
  );
  assert.match(releaseUrl({ downloadBaseUrl: "https://mirror.example/", version: "v2.15.0", platform: "linux", arch: "arm64" }), /golangci-lint-2\.15\.0-linux-arm64\.tar\.gz$/);
});

/** A stand-in release server: it serves a tarball whose binary prints the version it was built with. */
function fakeReleaseServer({ status = 200 } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-release-"));
  const inner = "golangci-lint-2.15.0-linux-amd64";
  fs.mkdirSync(path.join(stage, inner, "bin"), { recursive: true });
  fs.writeFileSync(path.join(stage, inner, "bin", "golangci-lint"), "#!/bin/sh\necho golangci-lint version v2.15.0\n", { mode: 0o755 });
  const archive = path.join(stage, "release.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, inner]);

  const server = http.createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("not here");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(fs.readFileSync(archive));
  });

  return {
    start: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ downloadBaseUrl: `http://127.0.0.1:${server.address().port}` }));
      }),
    close: () => {
      server.close();
      server.closeAllConnections?.();
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}

test("an unpinned-by-image release is fetched once and reused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-lint-install-"));
  const server = fakeReleaseServer();
  const { downloadBaseUrl } = await server.start();
  try {
    const cfg = cfgFor(dir, { toolchain: { downloadBaseUrl } });
    const first = await ensureGolangciLint({ cfg, version: "v2.15.0", downloadBaseUrl, log: () => {} });

    assert.equal(first.cached, false);
    assert.ok(fs.existsSync(first.path));
    const output = execFileSync(first.path, ["--version"], { encoding: "utf8" });
    assert.match(output, /golangci-lint version v2\.15\.0/);

    const second = await ensureGolangciLint({ cfg, version: "v2.15.0", downloadBaseUrl, log: () => {} });
    assert.equal(second.cached, true, "the second call does not download again");
    assert.equal(second.path, first.path);

    // The archive is not left behind in the tools dir.
    assert.deepEqual(fs.readdirSync(path.join(dir, "tools", "golangci-lint", "v2.15.0")).sort(), ["bin"]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a host outside tools.allowHosts is refused before any request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-lint-deny-"));
  try {
    const cfg = { toolchain: { installDir: path.join(dir, "tools"), downloadBaseUrl: "https://evil.example" }, tools: { allowHosts: ["github.com"] } };
    await assert.rejects(() => ensureGolangciLint({ cfg, version: "v2.15.0", log: () => {} }), /refusing to fetch from evil\.example: not in tools\.allowHosts/);
    assert.equal(fs.existsSync(path.join(dir, "tools", "golangci-lint", "v2.15.0")), false, "nothing is kept for a refused fetch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a redirect to a host outside the allowlist is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-lint-redirect-"));
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: "http://asset-host.example.invalid/golangci-lint.tar.gz" });
    res.end();
  });
  const base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  try {
    const cfg = cfgFor(dir, { toolchain: { downloadBaseUrl: base } });
    await assert.rejects(
      () => ensureGolangciLint({ cfg, version: "v2.15.0", downloadBaseUrl: base, log: () => {} }),
      /refusing to fetch from asset-host\.example\.invalid: not in tools\.allowHosts/,
    );
  } finally {
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing release names the URL it could not fetch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-lint-404-"));
  const server = fakeReleaseServer({ status: 404 });
  const { downloadBaseUrl } = await server.start();
  try {
    const cfg = cfgFor(dir, { toolchain: { downloadBaseUrl } });
    await assert.rejects(
      () => ensureGolangciLint({ cfg, version: "v2.15.0", downloadBaseUrl, log: () => {} }),
      /could not fetch http:\/\/127\.0\.0\.1:\d+\/golangci\/golangci-lint\/releases\/download\/v2\.15\.0\/golangci-lint-2\.15\.0-linux-amd64\.tar\.gz/,
    );
    assert.equal(fs.existsSync(path.join(dir, "tools", "golangci-lint", "v2.15.0")), false, "a failed install leaves no half directory");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
