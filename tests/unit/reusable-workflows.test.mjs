/**
 * Handing the shared workflows repository to the review.
 *
 * The claim a review wants to make about CI usually lives in another repository's workflow file. What is
 * pinned here is that it is read with the harness credential and named by path, and that a failure says
 * which repository was unreadable instead of leaving "not reachable from here" in the review.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { splitReusableTarget, stageReusableWorkflows } from "../../src/tools/reusable-workflows.mjs";
import { buildTaskPrompt } from "../../src/agent/prompt.mjs";

const WORKFLOW = "name: go-build\non: workflow_call\njobs:\n  build:\n    steps:\n      - run: go install github.com/golangci/golangci-lint/cmd/golangci-lint@v2.12.2\n";

function fakeClient({ content = WORKFLOW, error = null } = {}) {
  const calls = [];
  return {
    calls,
    async getFile(owner, repo, filePath, ref) {
      calls.push({ owner, repo, filePath, ref });
      if (error) throw new Error(error);
      return content;
    },
  };
}

test("a reusable workflow is split into owner, repository and path", () => {
  assert.deepEqual(splitReusableTarget("acme/workflows/.github/workflows/go-build.yml"), {
    owner: "acme",
    repo: "workflows",
    filePath: ".github/workflows/go-build.yml",
  });
  assert.equal(splitReusableTarget("acme/workflows"), null);
});

test("the fetched workflow lands in the comparison root and is named by path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-reusable-"));
  const client = fakeClient();
  try {
    const staged = await stageReusableWorkflows({
      client,
      reusable: [{ workflow: "acme/workflows/.github/workflows/go-build.yml", ref: "bb7243d", source: ".github/workflows/test.yaml" }],
      compareDir: path.join(dir, "compare"),
    });
    assert.deepEqual(client.calls, [{ owner: "acme", repo: "workflows", filePath: ".github/workflows/go-build.yml", ref: "bb7243d" }]);
    assert.equal(staged.length, 1);
    assert.ok(staged[0].path.endsWith("acme-workflows@bb7243d/go-build.yml"), staged[0].path);
    assert.equal(fs.readFileSync(staged[0].path, "utf8"), WORKFLOW);

    const prompt = buildTaskPrompt({
      pr: { number: 7, repository: "acme/svc", title: "t", body: "", draft: false, head: { ref: "x", sha: "abc" }, base: { ref: "main", sha: "def" } },
      files: [],
      checkoutDir: "/work/x",
      headSha: "abc",
      lint: { requestedVersion: "v2.12.2", source: ".github/workflows/test.yaml", reusableStaged: staged },
    });
    assert.match(prompt, /acme\/workflows\/\.github\/workflows\/go-build\.yml@bb7243d -> /);
    assert.match(prompt, /raw\.githubusercontent\.com answers 404 for a private repository/);
    assert.match(prompt, /before claiming what it does or does not run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable workflow names the repository and the reason", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-reusable-404-"));
  try {
    const staged = await stageReusableWorkflows({
      client: fakeClient({ error: "HTTP 404 Not Found" }),
      reusable: [{ workflow: "acme/workflows/.github/workflows/go-release.yml", ref: "bb7243d", source: ".github/workflows/test.yaml" }],
      compareDir: path.join(dir, "compare"),
    });
    assert.equal(staged[0].path, null);
    assert.match(staged[0].note, /HTTP 404/);
    const prompt = buildTaskPrompt({
      pr: { number: 7, repository: "acme/svc", title: "t", body: "", draft: false, head: { ref: "x", sha: "abc" }, base: { ref: "main", sha: "def" } },
      files: [],
      checkoutDir: "/work/x",
      headSha: "abc",
      lint: { requestedVersion: "", source: "no pins", reusableStaged: staged },
    });
    assert.match(prompt, /acme\/workflows\/\.github\/workflows\/go-release\.yml@bb7243d -> not readable: HTTP 404/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the client reads a file from another repository at a ref, authenticated", async () => {
  const { createFakeGithubApi } = await import("../fakes/github-api.mjs");
  const { createGithubClient } = await import("../../src/github/client.mjs");
  const fixture = {
    owner: "acme",
    repo: "svc",
    pr: 7,
    base: { ref: "main", sha: "1111111111111111111111111111111111111111" },
    head: { ref: "feature", sha: "2222222222222222222222222222222222222222" },
    files: [],
    fileContents: { ".github/workflows/go-build.yml": WORKFLOW },
  };
  const github = createFakeGithubApi({ fixture, me: "octocat" });
  const { baseUrl } = await github.start();
  try {
    const client = createGithubClient({ baseUrl, token: "test-token" });
    const text = await client.getFile("acme", "workflows", ".github/workflows/go-build.yml", "bb7243d");
    assert.equal(text, WORKFLOW);
    assert.deepEqual(fixture.contentsCalls, [{ filePath: ".github/workflows/go-build.yml", ref: "bb7243d" }]);
    // A directory listing or a file with no content yields null, not an empty file to read.
    assert.equal(await client.getFile("acme", "workflows", ".github/workflows", "bb7243d"), null);
  } finally {
    github.close();
  }
});
