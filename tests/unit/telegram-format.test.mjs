/**
 * What a gate looks like in Telegram, and what a tap means.
 *
 * Callback data is limited to 64 bytes and the HTML subset is small, so both are pinned here rather than
 * discovered at run time against a live chat.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { backRows, decisionRows, findingHtml, findingRows, parseCallback, summaryHtml, toastFor } from "../../src/gate/telegram-format.mjs";

const comments = [
  { path: "go.mod", line: 7, start_line: null, body: "Sarama raised DefaultVersion from V2_6_0_0 to V2_8_0_0.\nNothing sets Config.Version here." },
  { path: "internal/api/pagination.go", line: 23, start_line: 20, body: "Page 1 starts at row 20." },
];

test("the gate message links the PR, bolds the verdict and lists findings by position", () => {
  const summary = [
    "PR: https://github.com/acme/svc/pull/71",
    "Head: c81a11a4",
    "Model verdict: request_changes → policy action: submit → GitHub event: REQUEST_CHANGES",
    "",
    "Review body:",
    "Dependabot asked for a re-review.",
    "",
    "Inline comments (2):",
    "  go.mod:7 (dup) — the summary's own copy of this line is dropped",
    "  internal/api/pagination.go:20-44 — and this one too",
  ].join("\n");
  const text = summaryHtml(summary, { comments, maxFindings: 8 });
  assert.match(text, /^<a href="https:\/\/github\.com\/acme\/svc\/pull\/71">pull request<\/a>\n/);
  assert.match(text, /<b>Model verdict: request_changes → policy action: submit/);
  assert.match(text, /1\. <code>go\.mod:7<\/code> Sarama raised DefaultVersion/);
  assert.match(text, /2\. <code>internal\/api\/pagination\.go:20-23<\/code>/);
  assert.doesNotMatch(text, /the summary's own copy/, "the inline block is not rendered twice");
});

test("a long finding list says how many are only reachable by number", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.go`, line: index + 1, start_line: null, body: `finding ${index + 1}` }));
  const text = summaryHtml("PR: https://github.com/acme/svc/pull/1", { comments: many, maxFindings: 8 });
  assert.match(text, /8\. <code>f7\.go:8<\/code> finding 8/);
  assert.doesNotMatch(text, /finding 9/);
  assert.match(text, /…4 more findings, tap their number\./);
});

test("summary text is escaped before it is marked up", () => {
  const text = summaryHtml('PR: https://example/x\n<script>alert("x")</script> & go.mod:7', { comments: [], maxFindings: 8 });
  assert.match(text, /&lt;script&gt;alert/);
  assert.doesNotMatch(text, /<script>/, "a reviewed branch cannot inject markup");
  assert.match(text, /<code>go\.mod:7<\/code>/, "escaping does not stop the code refs");
});

test("a finding view quotes the whole body", () => {
  const text = findingHtml({ id: "262970ec" }, comments[0], 0, 2);
  assert.match(text, /<b>Finding 1 of 2<\/b>/);
  assert.match(text, /gate 262970ec/);
  assert.match(text, /<blockquote>Sarama raised DefaultVersion from V2_6_0_0 to V2_8_0_0\.\nNothing sets Config\.Version here\.<\/blockquote>/);
  assert.doesNotMatch(text, /<br>/, "Telegram has no br tag");
});

test("callbacks round-trip inside the 64 byte budget", () => {
  const rows = [decisionRows("262970ec"), ...findingRows("262970ec", 12), backRows("262970ec", 12)];
  for (const row of rows) {
    for (const button of row) {
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, `${button.callback_data} is too long`);
    }
  }
  assert.deepEqual(parseCallback("ap:262970ec"), { kind: "decide", state: "approved", gateId: "262970ec" });
  assert.deepEqual(parseCallback("rj:262970ec"), { kind: "decide", state: "rejected", gateId: "262970ec" });
  assert.deepEqual(parseCallback("hd:262970ec"), { kind: "decide", state: "held", gateId: "262970ec" });
  assert.deepEqual(parseCallback("fw:262970ec:3"), { kind: "finding", gateId: "262970ec", index: 3 });
  assert.deepEqual(parseCallback("bk:262970ec"), { kind: "back", gateId: "262970ec" });
  assert.equal(parseCallback("rm -rf /"), null);
});

test("finding buttons are numbered in rows of five", () => {
  const rows = findingRows("262970ec", 7);
  assert.deepEqual(rows.map((row) => row.length), [5, 2]);
  assert.equal(rows[1][1].text, "7");
});

test("the toast says what the tap did", () => {
  assert.equal(toastFor("approved"), "approved");
  assert.equal(toastFor("held"), "on hold");
});
