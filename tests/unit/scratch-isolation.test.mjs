/**
 * Each run works in its own scratch area.
 *
 * A carried-over session keeps naming the paths it saw, and a shared comparison root would put one run's
 * fetched clones in front of another run as though they belonged to it. Both the worktree and the
 * comparison directory are therefore per run, and the comparison directory goes away with the run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { comparisonDir, newRunId, releaseWorktree, sweepScratch, worktreeDir } from "../../src/checkout.mjs";

const cfg = { checkout: { mode: "clone", scratch: "/work/scratch", compareDir: "/work/scratch/refs" } };

test("two runs of the same head get different worktrees", () => {
  const first = worktreeDir(cfg, "acme", "svc", 7, "abcdef1234567890", "run11111");
  const second = worktreeDir(cfg, "acme", "svc", 7, "abcdef1234567890", "run22222");

  assert.match(first, /acme-svc-7-abcdef12-run11111$/);
  assert.notEqual(first, second, "no run inherits another run's build output");
});

test("the comparison directory is per run and per repository", () => {
  const mine = comparisonDir(cfg, "acme", "svc", 7, "abcdef1234567890", "run11111");
  const otherRepo = comparisonDir(cfg, "acme", "other", 7, "abcdef1234567890", "run11111");
  const otherRun = comparisonDir(cfg, "acme", "svc", 7, "abcdef1234567890", "run22222");

  assert.match(mine, /\/refs\/acme-svc-7-abcdef12-run11111$/);
  assert.notEqual(mine, otherRepo);
  assert.notEqual(mine, otherRun);
});

test("release removes the comparisons a run fetched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-scratch-"));
  const compare = path.join(dir, "refs", "acme-svc-7-abcdef12-run11111");
  try {
    fs.mkdirSync(path.join(compare, "dep"), { recursive: true });
    fs.writeFileSync(path.join(compare, "notes.md"), "trunk as of this run");

    releaseWorktree({ cfg, dir: path.join(dir, "wt"), cachedClone: null, compareDir: compare, log: () => {} });

    assert.equal(fs.existsSync(compare), false, "nothing is left for the next run to mistake for its own");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run ids differ", () => {
  const ids = new Set(Array.from({ length: 25 }, () => newRunId()));
  assert.equal(ids.size, 25);
});

test("scratch nothing can resume is swept, scratch a deferral keeps is not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-sweep-"));
  const scratch = path.join(dir, "scratch");
  const cfg = { checkout: { scratch, compareDir: path.join(scratch, "refs"), root: path.join(dir, "repos") } };
  const day = 86_400_000;
  const touch = (name, ageMs) => {
    const full = path.join(scratch, name);
    fs.mkdirSync(full, { recursive: true });
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(full, when, when);
    return full;
  };

  try {
    const kept = touch("acme-api-3-abcdef01-keep0001", 30 * day);
    const stale = touch("acme-api-3-abcdef01-gone0001", 30 * day);
    const young = touch("acme-api-4-12345678-fresh001", 1 * 3_600_000);
    const refs = touch("refs/acme-api-3-abcdef01-gone0002", 30 * day);

    const removed = sweepScratch({ cfg, keepRunIds: ["keep0001"], olderThanMs: 6 * 3_600_000 });

    assert.ok(fs.existsSync(kept), "a deferral points at this tree");
    assert.ok(fs.existsSync(young), "nothing has run out of the grace period yet");
    assert.ok(!fs.existsSync(stale), `expected ${stale} to be gone`);
    assert.ok(!fs.existsSync(refs), "the comparison copies go with the tree that made them");
    assert.equal(removed.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
