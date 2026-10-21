/**
 * review-once flags. The dry run is the flag an operator reaches for when they want to see a review
 * without GitHub seeing it, so it has to beat a config that allows posting.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, resolveDryRun } from "../../src/cli/review-once.mjs";

test("--dry-run overrides a config that permits posting", () => {
  const args = parseArgs(["--repo", "example/orders-svc", "--pr", "143", "--dry-run"]);
  assert.equal(args.dryRun, true);

  const cfg = { reviews: { dryRun: false } };
  assert.equal(resolveDryRun(cfg, args), true);
  assert.equal(cfg.reviews.dryRun, true);
});

test("--post opens a config that was holding back", () => {
  const cfg = { reviews: { dryRun: true } };
  assert.equal(resolveDryRun(cfg, parseArgs(["--post"])), false);
  assert.equal(cfg.reviews.dryRun, false);
});

test("--dry-run wins if both flags are given", () => {
  const cfg = { reviews: { dryRun: false } };
  assert.equal(resolveDryRun(cfg, parseArgs(["--post", "--dry-run"])), true);
});

test("nothing about the flags is implied by position", () => {
  const args = parseArgs(["--repo", "example/orders-svc", "--pr", "143"]);
  assert.equal(args.post, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.repo, "example/orders-svc");
});
