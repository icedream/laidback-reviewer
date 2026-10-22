/**
 * One finding, one comment.
 *
 * The wording a model produces on a second attempt at the same issue is close but not identical, so an
 * exact-string check let three sarama comments through on one PR.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { nearDuplicate, rangesOverlap, similarity } from "../../src/proposal/dedupe.mjs";

const first = {
  path: "go.mod",
  line: 7,
  body: "Sarama changed the Kafka version it assumes when `Config.Version` is left unset: DefaultVersion = V2_6_0_0 at utils.go:308 in v1.60.0 becomes V2_8_0_0 at utils.go:315 in v1.61.1, and no Config.Version is set anywhere in this service.",
};

test("a re-drafted wording of the same finding is the same finding", () => {
  const reworded = {
    path: "go.mod",
    line: 7,
    body: "Sarama raised the Kafka version it assumes when Config.Version is unset: DefaultVersion = V2_6_0_0 at utils.go:308 in v1.60.0, V2_8_0_0 at utils.go:315 in v1.61.1. Nothing here sets Config.Version.",
  };
  assert.ok(similarity(first.body, reworded.body) >= 0.35, `similarity was ${similarity(first.body, reworded.body)}`);
  assert.ok(nearDuplicate([first], reworded), "the second attempt is refused");
});

test("a different finding on the same line still gets through", () => {
  const other = { path: "go.mod", line: 7, body: "This bump also drops support for Go 1.21, which the build matrix in .github/workflows/ci.yml still exercises." };
  assert.equal(nearDuplicate([first], other), null);
});

test("unrelated findings stay far from the threshold", () => {
  const grpc = { path: "go.mod", line: 7, body: "Trunk moved grpc to v1.83.2 in 0fd88c6, which postdates this branch fork, so this line re-pins v1.83.1, the version GHSA-2vr5 was filed against." };
  assert.ok(similarity(first.body, grpc.body) < 0.2, `unrelated similarity was ${similarity(first.body, grpc.body)}`);
  assert.equal(nearDuplicate([first], grpc), null);
});

test("the same finding in another file is not a duplicate", () => {
  const elsewhere = { ...first, path: "go.sum", line: 41 };
  assert.equal(nearDuplicate([first], elsewhere), null);
});

test("ranges that do not touch are not the same site", () => {
  assert.equal(rangesOverlap({ line: 7 }, { line: 126 }), false);
  assert.equal(rangesOverlap({ start_line: 5, line: 9 }, { start_line: 8, line: 12 }), true);
});
