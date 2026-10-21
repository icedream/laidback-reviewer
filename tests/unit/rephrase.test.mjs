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

test("an answer with no shared wording falls back", () => {
  const parsed = parseRephrasedBanners("script exhausted", configured);
  assert.equal(parsed.prefix, configured.prefix);
  assert.equal(parsed.suffix, configured.suffix);
  assert.match((parsed.notes ?? []).join(" "), /shares no wording/);
});

test("SKIP keeps the slot instead of inventing one", () => {
  const parsed = parseRephrasedBanners("SKIP\nSKIP", { prefix: "", suffix: "" });
  assert.deepEqual(parsed, {});
});
