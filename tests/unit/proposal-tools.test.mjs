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

function labTools(stub) {
  const collector = createProposalCollector();
  const tools = createReviewTools({ collector, limits: { lab: { egress: "registries" } }, lab: stub });
  return { collector, tools, lab: tools.find((tool) => tool.name === "review_lab") };
}

test("a lab call is recorded as a gate row the operator can read back", async () => {
  const seen = [];
  const stub = {
    async call(action, payload) {
      seen.push({ action, payload });
      return { ok: true, action, exit: 0, stdout: "3 migrations applied, 0 errors", stderr: "", image: payload.image, jobId: "j-7", durationMs: 18_400, egress: "registries" };
    },
  };
  const { collector, lab } = labTools(stub);

  const result = await lab.execute("1", { action: "run", image: "postgres:16-alpine", cmd: "psql -f migration.sql", label: "does the migration apply" });

  assert.deepEqual(seen[0].action, "run");
  assert.match(result.content[0].text, /lab run: exit 0 in 18400ms/);
  assert.match(result.content[0].text, /3 migrations applied/);
  assert.equal(result.details.result, "pass");
  assert.deepEqual(collector.gates.map((gate) => gate.gate), ["lab run: postgres:16-alpine (does the migration apply)"]);
});

test("a lab that could not run still leaves its row, marked not_run", async () => {
  const stub = { async call() { return { ok: false, error: "lab daemon unreachable: connect ECONNREFUSED" }; } };
  const { collector, lab } = labTools(stub);

  const result = await lab.execute("1", { action: "build", dockerfile: "Dockerfile" });

  assert.match(result.content[0].text, /did not run: lab daemon unreachable/);
  assert.equal(collector.gates.length, 1, "the attempt is recorded even when it went nowhere");
  assert.equal(collector.gates[0].result, "not_run");
});

test("no lab tool without a lab", () => {
  assert.equal(labTools(null).lab, undefined, "disabled config offers no door");
});
