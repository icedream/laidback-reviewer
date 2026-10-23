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
        { id: 2, path: "internal/server/server.go", line: 88, user: { login: "maintainer" }, body: "This swallows the context cancellation error.\n\nRetry with a timeout." },
        { id: 3, path: "go.mod", line: 12, user: { login: "maintainer" }, body: "x".repeat(900) },
      ],
    },
  });

  assert.match(prompt, /Review history of this PR as GitHub holds it/);
  assert.match(prompt, /review by maintainer \(CHANGES_REQUESTED\)/);
  assert.match(prompt, /inline on internal\/server\/server\.go:88 by maintainer: This swallows the context cancellation error\. Retry with a timeout\./);
  assert.ok(prompt.includes("x".repeat(600)) && !prompt.includes("x".repeat(601)), "a long body is clipped, not pasted whole");
});

test("a PR nobody has looked at says so", () => {
  const prompt = buildTaskPrompt({ pr, files, checkoutDir: "/work/x", headSha: "abcdef0123456789", prior: { reviews: [], comments: [] } });

  assert.match(prompt, /No review, no inline comment and no discussion is on this PR yet/);
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

  assert.match(prompt, /Review history of this PR/);
  assert.match(prompt, /Re-review: the review was requested again at 2026-04-03T11:24:00Z, after an earlier pass over\s*this same head at 2026-04-01T00:00:00\.000Z\./);
  assert.match(prompt, /say what has changed\s*since, and whether the earlier concerns still stand/);
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

test("a requested rerun is told the earlier review is being replaced, not corrected", () => {
  const rerun = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/scratch/acme-svc-7-abcdef01",
    headSha: pr.head.sha,
    resume: { at: "2026-04-04T09:00:00.000Z", sessionFile: "/data/sessions/run-1.jsonl", reason: "rerun" },
  });
  assert.match(rerun, /another pass was asked for on the gate that held the previous review/);
  assert.match(rerun, /being replaced, not corrected/);
  assert.match(rerun, /Treat its findings as a draft/);
  assert.doesNotMatch(rerun, /inference server was occupied/, "nobody deferred this pass");

  // The interrupted case must not pick up the rerun wording.
  const interrupted = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/scratch/acme-svc-7-abcdef01",
    headSha: pr.head.sha,
    resume: { at: "2026-04-04T09:00:00.000Z", sessionFile: "/data/sessions/run-1.jsonl", reason: "interrupted" },
  });
  assert.match(interrupted, /interrupted at 2026-04-04T09:00:00\.000Z because the inference server was occupied/);
  assert.doesNotMatch(interrupted, /replaced, not corrected/);
});

test("what is already on the PR includes what the earlier review actually said", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/scratch/acme-svc-7-abcdef01",
    headSha: pr.head.sha,
    prior: {
      reviews: [{ id: 900, user: { login: "octocat" }, state: "CHANGES_REQUESTED", body: "The grpc dependency is re-pinned below trunk, which loses the GHSA fix.\nSecond paragraph of the same finding." }],
      comments: [{ path: "go.mod", line: 126, user: { login: "octocat" }, body: "x".repeat(900) }],
    },
  });
  assert.match(prompt, /The grpc dependency is re-pinned below trunk/);
  assert.ok(prompt.includes("Second paragraph of the same finding."), "author and state alone do not stop a repeat");
  assert.match(prompt, /inline on go\.mod:126 by octocat: xxx+/, "inline bodies carry, clipped");
  const longest = (prompt.match(/x+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  assert.ok(longest <= 600, `expected the inline body clipped, saw a run of ${longest}`);
});

test("the history names who said what, and how to treat it", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/x",
    headSha: pr.head.sha,
    prior: {
      reviews: [{ id: 1, user: { login: "octocat" }, state: "CHANGES_REQUESTED", body: "grpc is re-pinned below trunk, which drops the GHSA fix." }],
      comments: [{ id: 2, path: "go.mod", line: 126, user: { login: "octocat" }, body: "v1.83.1 here, trunk is on v1.83.2." }],
      discussion: [{ id: 3, user: { login: "author" }, body: "Rebasing once the other bump lands." }],
    },
  });
  assert.match(prompt, /review by octocat \(CHANGES_REQUESTED\): grpc is re-pinned below trunk/);
  assert.match(prompt, /inline on go\.mod:126 by octocat: v1\.83\.1 here, trunk is on v1\.83\.2\./);
  assert.match(prompt, /comment by author: Rebasing once the other bump lands\./);
  assert.match(prompt, /A finding already on this PR is not a new one/);
  assert.match(prompt, /Something the author answered stays answered/);
});

test("a second look found in the store is named without a request event", () => {
  const prompt = buildTaskPrompt({ pr, files, checkoutDir: "/work/x", headSha: pr.head.sha, reRequest: { handledAt: "2026-04-01T00:00:00.000Z" } });
  assert.match(prompt, /Re-review: this head was already reviewed here at 2026-04-01T00:00:00\.000Z, and this pass is the second look at it\./);
  assert.match(prompt, /say what has changed\s*since, and whether the earlier concerns still stand\./);
});

test("the prompt names what the image lacks and what the credential can read", () => {
  const prompt = buildTaskPrompt({
    pr,
    files,
    checkoutDir: "/work/x",
    headSha: pr.head.sha,
    compareDir: "/work/scratch/compare",
    writableRoots: ["/work/scratch"],
    allowHosts: ["github.com", "proxy.golang.org"],
  });
  assert.match(prompt, /There is no container runtime, database server, kubectl, helm,/);
  assert.match(prompt, /do not spend a turn testing whether they exist/);
  assert.match(prompt, /you may name in the review what you ran and against which/);
  assert.match(prompt, /What stays out is this runner and its limits/);
  assert.match(prompt, /which credentials were missing/);
  assert.match(prompt, /the shell has no default time limit/);
  assert.match(prompt, /uses: <org>\/<repo>\/\.\.\.@<ref>` names the repository and the ref/);
  assert.match(prompt, /This credential reads the organisation's private repositories/);
  assert.match(prompt, /git tag --sort=-creatordate/);
});

test("the lab is described by what a review can do with it", () => {
  const base = { pr, files, checkoutDir: "/work/x", headSha: "abcdef0123456789", writableRoots: ["/tmp"] };
  const prompt = buildTaskPrompt({ ...base, lab: { egress: "registries", cpus: 4, memoryMb: 4096, jobTimeoutMs: 600_000 } });
  assert.match(prompt, /build an image, start a/);
  assert.match(prompt, /through review_lab, never through the shell/);
  assert.match(prompt, /Egress registries; ceiling 4 cpus, 4096 MB,/);
  assert.match(prompt, /10 minutes per job/);
  assert.match(prompt, /Report a lab result as evidence about the pull request, and say nothing about the lab itself/);

  assert.doesNotMatch(buildTaskPrompt(base), /review_lab/, "no lab, no paragraph");
});
