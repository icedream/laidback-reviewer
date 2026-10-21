import test from "node:test";
import assert from "node:assert/strict";
import { composeReview, validateBannerSlot, assembleBody } from "../../src/proposal/policy.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

const cfg = () => baseConfig({ dir: "/tmp" });
const files = [{ filename: "a.go", status: "modified", patch: "@@ -1,2 +1,3 @@\n one\n+two\n three" }];
const proposal = (overrides = {}) => ({
  body: "LGTM on the shape.",
  verdict: "approve",
  comments: [{ path: "a.go", line: 2, body: "one issue here" }],
  blocking: [],
  ...overrides,
});

test("hint is the default on both verdict axes", () => {
  const composed = composeReview({ proposal: proposal(), cfg: cfg(), files, headSha: "abc" });
  assert.equal(composed.event, "COMMENT");
  assert.match(composed.payload.body, /I would have approved this\./);
});

test("submit passes the verdict through", () => {
  const config = cfg();
  config.reviews.approve = "submit";
  const composed = composeReview({ proposal: proposal(), cfg: config, files, headSha: "abc" });
  assert.equal(composed.event, "APPROVE");
  assert.doesNotMatch(composed.payload.body, /I would have approved/);
});

test("drop removes the verdict line and still posts the findings", () => {
  const config = cfg();
  config.reviews.approve = "drop";
  const composed = composeReview({ proposal: proposal(), cfg: config, files, headSha: "abc" });
  assert.equal(composed.event, "COMMENT");
  assert.doesNotMatch(composed.payload.body, /Verdict/);
  assert.equal(composed.payload.comments.length, 1);
});

test("a requested change in hint mode names the blockers", () => {
  const composed = composeReview({
    proposal: proposal({ verdict: "request_changes", blocking: ["offset skips a page"] }),
    cfg: cfg(),
    files,
    headSha: "abc",
  });
  assert.equal(composed.event, "COMMENT");
  assert.match(composed.payload.body, /I would have requested changes\. Blocking: offset skips a page/);
});

test("a long blocker list points at the comments instead of restating them", () => {
  const composed = composeReview({
    proposal: proposal({
      verdict: "request_changes",
      blocking: [
        "internal/api/pagination.go:22-24 Offset() skips the first page of orders because page is 1-based",
        "internal/service/orders.go:79 the decode error is discarded so a broken upstream reads as empty",
        "internal/api/pagination.go:29-42 the lower-bound validation that answered 400 is gone",
      ],
    }),
    cfg: cfg(),
    files,
    headSha: "abc",
  });
  assert.match(composed.payload.body, /Blocking 3 items, named in the inline comments\./);
});

test("the configured suffix lands at the end of the body and the prefix at the start", () => {
  const config = cfg();
  config.banner.prefix = "On leave this week; this review is the bot.";
  const composed = composeReview({ proposal: proposal(), cfg: config, files, headSha: "abc" });
  assert.ok(composed.payload.body.startsWith("On leave this week"));
  assert.ok(composed.payload.body.endsWith("</sub>"));
});

test("comment cap keeps the first ones and records what was dropped", () => {
  const config = cfg();
  config.reviews.maxComments = 2;
  const many = proposal({
    comments: [1, 2, 3, 4].map((line) => ({ path: "a.go", line: 2, body: `issue ${line}` })),
  });
  const composed = composeReview({ proposal: many, cfg: config, files, headSha: "abc" });
  assert.equal(composed.payload.comments.length, 2);
  assert.match(composed.notes.join("\n"), /dropped 2 comments over maxComments=2/);
});

test("a suggestion is appended as a fenced suggestion block", () => {
  const composed = composeReview({
    proposal: proposal({ comments: [{ path: "a.go", line: 2, body: "use 0-based pages", suggestion: "return (q.Page - 1) * q.PerPage" }] }),
    cfg: cfg(),
    files,
    headSha: "abc",
  });
  assert.match(composed.payload.comments[0].body, /```suggestion\nreturn \(q\.Page - 1\) \* q\.PerPage\n```$/);
});

test("an empty proposal is refused instead of posting a blank review", () => {
  assert.throws(() => composeReview({ proposal: { body: "", verdict: "comment", comments: [] }, cfg: cfg(), files, headSha: "abc" }), /empty/);
});

test("banner rephrase cannot add a verdict claim, a link, or markup", () => {
  assert.equal(validateBannerSlot("I'm on leave; the bot answers meanwhile.", "On leave this week, so this review comes from the bot.").ok, true);
  assert.equal(validateBannerSlot("I'm on leave.", "Approved and merged by the bot.").ok, false);
  assert.equal(validateBannerSlot("I'm on leave.", "See https://example.com for details.").ok, false);
  assert.equal(validateBannerSlot("plain text", "bot <img src=x> review").ok, false);
  assert.equal(validateBannerSlot("plain text", "line one\nline two\nline three").ok, false);
  assert.equal(validateBannerSlot("plain text", "").ok, false);
});

test("assembleBody skips empty slots", () => {
  assert.equal(assembleBody({ prefix: "", body: "b", verdictLine: "", suffix: "" }), "b");
});
