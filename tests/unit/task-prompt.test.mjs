/**
 * What the task prompt tells the agent about its working area.
 *
 * The tool policy refuses writes outside the scratch roots. If the prompt does not name them, the agent
 * finds out by being refused, and the refusal lands in the review as a complaint about the harness.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPrompt } from "../../src/agent/prompt.mjs";

const pr = {
  number: 7,
  repository: "acme/svc",
  title: "ORD-142 filter by customer id",
  body: "Implements ORD-142.",
  draft: false,
  head: { ref: "feature/filter", sha: "abcdef0123456789" },
  base: { ref: "main", sha: "1111111111111111111111111111111111111111" },
};

const files = [{ filename: "internal/server/server.go", status: "modified", additions: 4, deletions: 1, patch: "@@ -40,6 +40,9 @@\n-old\n+new\n" }];

test("the prompt names the writable roots and forbids writing in the checkout", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/scratch/acme-svc-7-abcdef01",
    headSha: "abcdef0123456789",
    compareDir: "/work/scratch/refs",
    writableRoots: ["/work/scratch", "/work/tools", "/tmp"],
    allowHosts: ["github.com", "proxy.golang.org"],
  });

  assert.match(prompt, /Writing is allowed under \/work\/scratch, \/work\/tools and \/tmp:/);
  assert.match(prompt, /'go mod tidy' or 'npm install' is fine in a copy/);
  assert.match(prompt, /from: github.com, proxy.golang.org/, "the hosts a tool download may use");
  assert.match(prompt, /Never write\s*\n?inside the checkout itself/);
  assert.match(prompt, /Put anything you fetch outside this PR in \/work\/scratch\/refs/);
});

test("a single root reads as one root", () => {
  const prompt = buildTaskPrompt({ pr, files, checkoutDir: "/work/x", headSha: "abcdef0123456789", writableRoots: ["/tmp"] });
  assert.match(prompt, /Writing is allowed under \/tmp:/);
});

test("the ticket keys and the commentable line numbers are both in front of the agent", () => {
  const prompt = buildTaskPrompt({ pr, files, checkoutDir: "/work/x", headSha: "abcdef0123456789" });

  assert.match(prompt, /Ticket keys referenced: ORD-142/);
  assert.match(prompt, /internal\/server\/server\.go \[modified, \+4\/-1\] commentable RIGHT lines/);
});
