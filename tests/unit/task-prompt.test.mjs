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

test("a carried-over session is told that its old paths are gone", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/scratch/acme-svc-9-ffee0011-3c1d2e4f",
    headSha: "abcdef0123456789",
    context: { description: "stacked on #8", instructions: "review only what changed", review: { checkout_dir: "/work/scratch/acme-svc-8-11aa22bb-9z8y7x6w" } },
  });

  assert.match(prompt, /Carried-over context: stacked on #8/);
  assert.match(prompt, /\/work\/scratch\/acme-svc-8-11aa22bb-9z8y7x6w\) were one run's scratch area and no longer exist/);
});

test("what is already on the PR is named, so the review does not repeat it", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/x",
    headSha: "abcdef0123456789",
    prior: {
      reviews: [{ id: 1, user: { login: "maintainer" }, state: "CHANGES_REQUESTED" }],
      comments: [
        { id: 2, path: "internal/server/server.go", line: 88, body: "This swallows the context cancellation error.\n\nRetry with a timeout." },
        { id: 3, path: "go.mod", line: 12, body: "x".repeat(400) },
      ],
    },
  });

  assert.match(prompt, /Already on this PR \(do not repeat these findings\):/);
  assert.match(prompt, /review 1 by maintainer: CHANGES_REQUESTED/);
  assert.match(prompt, /inline on internal\/server\/server\.go:88: This swallows the context cancellation error\. Retry with a timeout\./);
  assert.ok(prompt.includes("x".repeat(160)) && !prompt.includes("x".repeat(161)), "a long body is clipped, not pasted whole");
});

test("a PR nobody has looked at says so", () => {
  const prompt = buildTaskPrompt({ pr, files, checkoutDir: "/work/x", headSha: "abcdef0123456789", prior: { reviews: [], comments: [] } });

  assert.match(prompt, /No review and no inline comment exists on this PR yet\./);
});

test("a re-review is named, so the model reports what changed instead of repeating itself", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/x",
    headSha: "abcdef0123456789",
    prior: { reviews: [{ id: 9, user: { login: "octocat" }, state: "COMMENTED" }], comments: [] },
    reRequest: { askedAt: "2026-04-03T11:24:00Z", handledAt: "2026-04-01T00:00:00.000Z", rereviews: 1 },
  });

  assert.match(prompt, /Already on this PR/);
  assert.match(prompt, /Re-review: the review was requested again at 2026-04-03T11:24:00Z[\s\S]*earlier pass of this[\s\S]*same head at 2026-04-01T00:00:00.000Z/);
  assert.match(prompt, /say what has changed since, and whether the earlier concerns still stand/);
});

test("a resumed run is told it is continuing, not starting over", () => {
  const withResume = buildTaskPrompt({ pr, files, checkoutDir: "/work/scratch/acme-svc-7-abcdef01", headSha: pr.head.sha, resume: { at: "2026-04-04T09:00:00.000Z", sessionFile: "/data/sessions/run-1.jsonl" } });
  assert.match(withResume, /Resumed run/);
  assert.match(withResume, /continue/, "the point of the fork is to carry on");
  assert.match(withResume, /re-run any command/, "the scratch tree behind the old turns is gone");

  // With the tree kept, saying it is gone would send the model to redo work that is sitting there.
  const kept = buildTaskPrompt({ pr, files, checkoutDir: "/work/scratch/acme-svc-7-abcdef01", headSha: pr.head.sha, resume: { at: "2026-04-04T09:00:00.000Z", sessionFile: "/data/sessions/run-1.jsonl", scratchKept: true } });
  assert.match(kept, /scratch tree is still in place at \/work\/scratch\/acme-svc-7-abcdef01/);
  assert.doesNotMatch(kept, /directories are\s+gone/);

  const plain = buildTaskPrompt({ pr, files, checkoutDir: "/work/scratch/acme-svc-7-abcdef01", headSha: pr.head.sha });
  assert.doesNotMatch(plain, /Resumed run/);
});
