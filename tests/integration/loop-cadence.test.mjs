/**
 * How quickly the loop reacts to a tap.
 *
 * Discovery polls GitHub on github.pollIntervalMs, which is minutes. A gate decision must not wait for the
 * next discovery pass: the tap should start the work within gate.pollIntervalMs. The clock is injected, so
 * this measures the scheduling rather than wall time.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runLoop } from "../../src/loop.mjs";

function harness({ pollIntervalMs = 60_000, gatePollMs = 5_000 } = {}) {
  const cfg = { github: { pollIntervalMs }, gate: { pollIntervalMs: gatePollMs } };
  let clock = 0;
  const cycleAt = [];
  let pendingDecision = null;
  const stop = { current: false };
  const transport = {
    expire: () => 0,
    readDecisions: async () => {
      if (!pendingDecision) return [];
      const decided = [pendingDecision];
      pendingDecision = null;
      return decided;
    },
  };
  const runCycle = async () => {
    cycleAt.push(clock);
    if (cycleAt.length === 1) pendingDecision = { id: "6a115a98", state: "approved", decided_by: "telegram:132295711" };
    if (cycleAt.length >= 2) stop.current = true;
  };
  const nap = async (ms) => {
    clock += ms;
  };
  return { cfg, clock: () => clock, cycleAt, transport, stop, runCycle, nap, setDecision: (d) => { pendingDecision = d; } };
}

test("a tap landing between cycles runs the next cycle at once", async () => {
  const h = harness();
  await runLoop({ cfg: h.cfg, store: {}, client: {}, transport: h.transport, stop: h.stop, runCycle: h.runCycle, now: h.clock, nap: h.nap });

  assert.equal(h.cycleAt.length, 2, "the tap triggered a follow-up cycle");
  assert.ok(h.cycleAt[1] <= 5_000, `second cycle ran at ${h.cycleAt[1]}ms; expected within the gate poll interval, not at ${h.cfg.github.pollIntervalMs}ms`);
});

test("an unanswered gate does not add cycles, and no transport means no polling", async () => {
  const quiet = harness();
  quiet.setDecision(null);
  const stopAfter = { current: false };
  let cycles = 0;
  await runLoop({
    cfg: { github: { pollIntervalMs: 30_000 }, gate: { pollIntervalMs: 5_000 } },
    store: {},
    client: {},
    transport: { expire: () => 0, readDecisions: async () => [] },
    stop: stopAfter,
    runCycle: async () => {
      cycles += 1;
      if (cycles >= 2) stopAfter.current = true;
    },
    now: quiet.clock,
    nap: quiet.nap,
  });
  assert.equal(cycles, 2, "one cycle per discovery interval when nothing was decided");
  assert.ok(quiet.clock() >= 30_000 && quiet.clock() < 40_000, `clock at ${quiet.clock()}ms`);

  const none = harness();
  let ran = 0;
  await runLoop({
    cfg: none.cfg,
    store: {},
    client: {},
    transport: null,
    stop: none.stop,
    runCycle: async () => {
      ran += 1;
      if (ran >= 1) none.stop.current = true;
    },
    now: none.clock,
    nap: none.nap,
  });
  assert.equal(ran, 1, "a run with no gate transport still cycles once and stops");
});
