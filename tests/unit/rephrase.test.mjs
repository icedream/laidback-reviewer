import test from "node:test";
import assert from "node:assert/strict";
import { parseRephrasedBanners } from "../../src/agent/rephrase.mjs";

const configured = { prefix: "I'm on leave this week; the bot answers meanwhile.", suffix: "<sub>This review was performed by a local AI bot.</sub>" };

test("a rewrite that keeps the claims is accepted", () => {
  const parsed = parseRephrasedBanners(
    "On leave this week, so the bot answers in the meantime.\n<sub>Review performed by a local AI bot.</sub>",
    configured,
  );
  assert.match(parsed.prefix, /On leave this week/);
  assert.match(parsed.suffix, /^<sub>Review performed by a local AI bot\.<\/sub>$/);
  assert.equal(parsed.notes, undefined);
});

test("markup labels are stripped from the answer", () => {
  const parsed = parseRephrasedBanners("prefix: on leave this week, bot answers meanwhile\nsuffix: <sub>local AI bot review</sub>", configured);
  assert.match(parsed.prefix, /^on leave/);
  assert.match(parsed.suffix, /^<sub>local AI bot review<\/sub>$/);
});

test("a rewrite that adds an approval claim falls back to the configured text", () => {
  const parsed = parseRephrasedBanners(
    "Approved while I'm on leave; the bot answers.\n<sub>Review by a local AI bot.</sub>",
    configured,
  );
  assert.equal(parsed.prefix, configured.prefix);
  assert.match(parsed.suffix, /^<sub>Review by a local AI bot\.<\/sub>$/);
  assert.match((parsed.notes ?? []).join(" "), /introduces a verdict or merge claim/);
});

test("an answer that keeps none of the claims falls back", () => {
  const parsed = parseRephrasedBanners("script exhausted", configured);
  assert.equal(parsed.prefix, configured.prefix);
  assert.equal(parsed.suffix, configured.suffix);
  assert.match((parsed.notes ?? []).join(" "), /no claim from the source survives/);
});

test("a rewrite may share nothing with the configured line and still keep the draft's claims", () => {
  const slots = { prefix: "Automated review: this pass was written by the repo's review bot, not by hand.", suffix: "" };
  const drafts = { prefix: "An automated reviewer wrote this pass rather than a person." };
  const parsed = parseRephrasedBanners("prefix: This pass came from the repo's review bot rather than from a person at a keyboard.", slots, drafts);
  assert.equal(parsed.suffix, undefined, "an empty slot is never offered");
  assert.match(parsed.prefix, /person at a keyboard/);
  assert.equal(parsed.notes, undefined, "a rewrite is allowed to change the words");

  const invented = parseRephrasedBanners("prefix: I will fix this and merge it myself.", slots, drafts);
  assert.equal(invented.prefix, slots.prefix);
  assert.match((invented.notes ?? []).join(" "), /introduces a verdict or merge claim/);
});

test("SKIP keeps the slot instead of inventing one", () => {
  const parsed = parseRephrasedBanners("SKIP\nSKIP", { prefix: "", suffix: "" });
  assert.deepEqual(parsed, {});
});
