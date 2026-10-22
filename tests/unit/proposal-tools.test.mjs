/**
 * The proposal tools record, and they record once.
 *
 * A comment queued twice reaches GitHub twice, which reads as padding and costs the reviewer's
 * attention. The second copy is refused at the tool call, where the model can still fold it into the
 * body instead.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createProposalCollector, createReviewTools } from "../../src/agent/tools.mjs";

function proposalTools() {
  const collector = createProposalCollector();
  const tools = createReviewTools({ collector, limits: {} });
  return { collector, comment: tools.find((tool) => tool.name === "review_propose_comment") };
}

test("the same finding cannot be queued twice", async () => {
  const { collector, comment } = proposalTools();
  const params = { path: "go.mod", line: 119, body: "the branch no longer merges onto main" };

  const first = await comment.execute("1", params);
  const second = await comment.execute("2", { ...params, body: "  the branch no longer merges onto main \n" });

  assert.equal(first.details.queued, true);
  assert.equal(second.details.duplicate, true);
  assert.match(second.content[0].text, /already queued/);
  assert.equal(collector.comments.length, 1, "one comment, not two");
});

test("the same sentence on another line is another comment", async () => {
  const { collector, comment } = proposalTools();

  await comment.execute("1", { path: "go.mod", line: 119, body: "same sentence" });
  await comment.execute("2", { path: "go.mod", line: 7, body: "same sentence" });

  assert.equal(collector.comments.length, 2, "two sites, two comments");

  // A range comment that already covers the line is the same site, not a second one.
  await comment.execute("3", { path: "go.mod", line: 119, start_line: 110, body: "same sentence" });
  assert.equal(collector.comments.length, 2, "the range wraps the finding it already carries");
});

test("a suggestion is part of the finding, not a duplicate of it", async () => {
  const { collector, comment } = proposalTools();

  await comment.execute("1", { path: "go.mod", line: 7, body: "pin the broker version" });
  await comment.execute("2", { path: "go.mod", line: 7, body: "pin the broker version", suggestion: "go 1.26.7" });

  assert.equal(collector.comments.length, 1, "the suggestion does not create a second thread");
});
