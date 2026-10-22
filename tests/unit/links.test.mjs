/**
 * Citation form.
 *
 * A bare permalink inside a sentence renders as a code-preview card in the middle of the line, and a plain
 * `go.mod:7` mention of a file the PR touches is a link the author does not get.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normaliseCitations } from "../../src/proposal/links.mjs";

const base = { owner: "acme", repo: "svc", headSha: "74e6b431a9631dc2950c07102d7034ed06a829bb", knownPaths: new Set(["go.mod", "pkg/analytics/kafka/client.go"]) };
const url = (file, from, to) => `https://github.com/acme/svc/blob/0fd88c6df915d7ac36bdcbd20d8e5fff858d4d56/${file}${to ? `#L${from}-L${to}` : `#L${from}`}`;

test("a bare permalink inside a sentence gains alt text", () => {
  const out = normaliseCitations(`Trunk moved grpc in ${url("go.mod", 127)}, which postdates the fork.`, base);
  assert.equal(out.inlined, 1);
  assert.match(out.text, /\[go\.mod:127\]\(https:\/\/github\.com\/acme\/svc\/blob\/0fd88c6[0-9a-f]*\/go\.mod#L127\)/);
});

test("a permalink alone on its line keeps the preview", () => {
  const out = normaliseCitations(url("go.mod", 127), { ...base, knownPaths: new Set() });
  assert.equal(out.inlined, 0);
  assert.equal(out.text, url("go.mod", 127));
});

test("two bare permalinks on one line are both given alt text", () => {
  const out = normaliseCitations(`see ${url("go.mod", 7)} and ${url("pkg/analytics/kafka/client.go", 63, 66)}`, base);
  assert.equal(out.inlined, 2);
  assert.match(out.text, /\[pkg\/analytics\/kafka\/client\.go:63-66\]\(/);
});

test("a plain mention of a touched file is pinned to the reviewed head", () => {
  const out = normaliseCitations("Nothing sets Config.Version, see go.mod:7 in this PR.", base);
  assert.equal(out.pinned, 1);
  assert.match(out.text, /\[go\.mod:7\]\(https:\/\/github\.com\/acme\/svc\/blob\/74e6b431a9631dc2950c07102d7034ed06a829bb\/go\.mod#L7\)/);
});

test("a file this PR does not touch stays plain text", () => {
  // utils.go belongs to sarama, not this repository: pinning it would link to a path that does not exist.
  const out = normaliseCitations("DefaultVersion = V2_6_0_0 at utils.go:308 in v1.60.0.", base);
  assert.equal(out.pinned, 0);
  assert.match(out.text, /utils\.go:308/);
});

test("code spans and suggestion fences are left alone", () => {
  const out = normaliseCitations("`go.mod:7` stays as code\n\n```suggestion\n// go.mod:7\n```\n", base);
  assert.equal(out.pinned, 0);
  assert.match(out.text, /`go\.mod:7` stays as code/);
});
