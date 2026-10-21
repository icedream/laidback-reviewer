import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision } from "../../src/gate/slack.mjs";

const gateIds = new Set(["ab12cd34"]);

test("approve and reject in the gate thread are read as decisions", () => {
  assert.deepEqual(parseDecision("approve ab12cd34", { gateIds }), { command: "approve", gateId: "ab12cd34", reason: null });
  assert.deepEqual(parseDecision("reject ab12cd34 anchor looks wrong", { gateIds }), {
    command: "reject",
    gateId: "ab12cd34",
    reason: "anchor looks wrong",
  });
});

test("a message about another gate, or with no gate id, is ignored", () => {
  assert.equal(parseDecision("approve 99ff00aa", { gateIds }), null);
  assert.equal(parseDecision("approve", { gateIds }), null);
  assert.equal(parseDecision("laidback-reviewer gate ab12cd34. Reply in this thread", { gateIds }), null);
});

test("only allowlisted users can decide a gate", () => {
  const allowUsers = ["U_ADMIN"];
  assert.equal(parseDecision("approve ab12cd34", { gateIds, allowUsers, user: "U_STRANGER" }), null);
  assert.equal(parseDecision("approve ab12cd34", { gateIds, allowUsers, user: "U_ADMIN" }).command, "approve");
});

test("an unrelated sentence is not parsed as a command", () => {
  assert.equal(parseDecision("I would approve ab12cd34 once the anchor is fixed", { gateIds }), null);
});
