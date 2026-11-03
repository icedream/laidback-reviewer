import test from "node:test";
import assert from "node:assert/strict";
import { anchorComment, commentableRuns, fitSuggestionAnchor, parsePatch } from "../../src/github/anchoring.mjs";

const patch = [
  "@@ -1,3 +1,6 @@",
  " line one",
  "+added two",
  "+added three",
  " line four",
  "@@ -40,3 +43,4 @@",
  "-old forty",
  "+new forty",
  " context forty one",
  " context forty two",
].join("\n");

const files = [{ filename: "a.go", status: "modified", patch }];

test("parsePatch tracks absolute line numbers on both sides", () => {
  const hunks = parsePatch(patch);
  assert.equal(hunks.length, 2);
  assert.deepEqual(
    hunks[0].lines.map((line) => [line.type, line.newLine]),
    [
      ["ctx", 1],
      ["add", 2],
      ["add", 3],
      ["ctx", 4],
    ],
  );
  assert.equal(hunks[1].lines[0].type, "del");
  assert.equal(hunks[1].lines[0].oldLine, 40);
});

test("commentableRuns merges the RIGHT side of a hunk and skips deleted lines", () => {
  assert.deepEqual(commentableRuns(patch), [
    { from: 1, to: 4, hunkIndex: 0 },
    { from: 43, to: 45, hunkIndex: 1 },
  ]);
});

test("a comment inside a hunk is accepted unchanged", () => {
  const result = anchorComment({ path: "a.go", line: 3, body: "x" }, files);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.comment, { path: "a.go", side: "RIGHT", body: "x", line: 3 });
});

test("a comment outside the diff is anchored to the nearest commentable line", () => {
  const result = anchorComment({ path: "a.go", line: 99, body: "x" }, files);
  assert.equal(result.status, "adjusted");
  assert.equal(result.comment.line, 45);
  assert.match(result.note, /not in the diff, anchored to 45/);
});

test("a range crossing uncommitted lines narrows to the commentable part", () => {
  const result = anchorComment({ path: "a.go", start_line: 2, line: 44, body: "x" }, files);
  assert.equal(result.status, "adjusted");
  assert.equal(result.comment.start_line, 43);
  assert.equal(result.comment.line, 44);
});

test("a range fully inside one hunk keeps both ends", () => {
  const result = anchorComment({ path: "a.go", start_line: 2, line: 3, body: "x" }, files);
  assert.equal(result.status, "ok");
  assert.equal(result.comment.start_line, 2);
  assert.equal(result.comment.line, 3);
});

test("files with no patch are dropped with a reason", () => {
  assert.equal(anchorComment({ path: "b.go", line: 1, body: "x" }, files).status, "dropped");
  assert.match(anchorComment({ path: "a.go", line: 1, body: "x" }, [{ filename: "a.go", status: "removed" }]).note, /no patch/);
});

test("start_line after line is dropped rather than swapped", () => {
  const result = anchorComment({ path: "a.go", start_line: 4, line: 2, body: "x" }, files);
  assert.equal(result.status, "dropped");
  assert.match(result.note, /start_line 4 after line 2/);
});
/**
 * The shape that broke a real review: one WHERE line changed inside a statement whose other lines are
 * unchanged context, which is a commentable range the length of the whole statement.
 */
const statement = [
  "@@ -22,4 +22,4 @@",
  " UPDATE principals SET type = sqlc.narg('type')::text, type = type",
  " email = CASE WHEN sqlc.arg('email_set')::boolean THEN sqlc.narg('email')::text ELSE email END,",
  " disabled = COALESCE(sqlc.narg('disabled')::boolean, disabled)",
  "-WHERE id = sqlc.arg('id')::uuid OR name = sqlc.arg('id')::text RETURNING *;",
  "+WHERE id = sqlc.arg('id')::uuid OR name = sqlc.arg('ref_name')::text RETURNING *;",
].join("\n");
const statementFiles = [{ filename: "q.sql", status: "modified", patch: statement }];

test("a suggestion is only safe when it covers its anchor", () => {
  const over = { path: "q.sql", start_line: 22, line: 25, body: "call the arg name" };
  const fitted = fitSuggestionAnchor({ comment: over, suggestion: "WHERE id = sqlc.arg('id')::uuid OR name = sqlc.arg('name')::text RETURNING *;", files: statementFiles });

  assert.equal(fitted.status, "fitted");
  assert.equal(fitted.comment.line, 25);
  assert.equal(fitted.comment.start_line, undefined, "a single line needs no range");
  assert.match(fitted.note, /spans 4 lines for a 1-line suggestion, narrowed to 25/);
});

test("a suggestion that repeats the context keeps its anchor", () => {
  const wide = [
    "email = CASE WHEN sqlc.arg('email_set')::boolean THEN sqlc.narg('email')::text ELSE email END,",
    "disabled = COALESCE(sqlc.narg('disabled')::boolean, disabled)",
    "WHERE id = sqlc.arg('id')::uuid OR name = sqlc.arg('name')::text RETURNING *;",
  ].join("\n");
  const result = fitSuggestionAnchor({ comment: { path: "q.sql", start_line: 23, line: 25, body: "x" }, suggestion: wide, files: statementFiles });

  assert.equal(result.status, "ok");
  assert.equal(result.comment.start_line, 23);
});

test("a suggestion that would delete unmentioned lines is refused", () => {
  const result = fitSuggestionAnchor({ comment: { path: "q.sql", start_line: 22, line: 25, body: "x" }, suggestion: "two\nlines", files: statementFiles });

  assert.equal(result.status, "dropped");
  assert.match(result.note, /covers 1 changed line\(s\) of them, so applying it would delete code/);
});

test("a suggestion wider than its anchor is an insertion, not a deletion", () => {
  const result = fitSuggestionAnchor({ comment: { path: "q.sql", line: 25, body: "x" }, suggestion: "WHERE id = sqlc.arg('id')::uuid\n  OR name = sqlc.arg('name')::text\nRETURNING *;", files: statementFiles });

  assert.equal(result.status, "ok");
});
