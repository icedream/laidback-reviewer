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
  await runLoop({ cfg: h.cfg, store: { approvedUnpostedReviews: () => [] }, client: {}, transport: h.transport, stop: h.stop, runCycle: h.runCycle, now: h.clock, nap: h.nap });

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
    store: { approvedUnpostedReviews: () => [] },
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
    store: { approvedUnpostedReviews: () => [] },
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

test("a tap pressed while a review is running is read before that review finishes", async () => {
  const cfg = { github: { pollIntervalMs: 60_000 }, gate: { pollIntervalMs: 5_000 } };
  const stop = { current: false };
  const reads = [];
  let inFlight = false;
  let releaseCycle = null;

  const transport = {
    expire: () => 0,
    readDecisions: async () => {
      reads.push(inFlight);
      if (inFlight) releaseCycle();
      return [];
    },
  };
  const runCycle = () =>
    new Promise((resolve) => {
      inFlight = true;
      releaseCycle = () => {
        inFlight = false;
        resolve();
      };
      stop.current = true;
    });

  // A real timer, because the point is that the gate is read while the cycle's own await is still open.
  await runLoop({
    cfg,
    store: { approvedUnpostedReviews: () => [] },
    client: { getPull: async () => { throw new Error("must not be reached"); } },
    transport,
    stop,
    runCycle,
    gateTimer: (ms, fn) => {
      const timer = setTimeout(fn, 0);
      return () => clearTimeout(timer);
    },
  });

  assert.ok(reads.includes(true), `the gate was only read at cycle boundaries: ${JSON.stringify(reads)}`);
});

test("a long-polling channel is read continuously, one request at a time", async () => {
  const cfg = { github: { pollIntervalMs: 30_000 }, gate: { pollIntervalMs: 5_000 } };
  const stop = { current: false };
  const reads = [];
  let outstanding = 0;
  let overlaps = 0;
  let inFlight = false;
  let releaseCycle = null;
  let cycleRead = null;

  const transport = {
    // The channel holds its request open, so a second one from the same process reads as a second bot
    // instance and the channel terminates the first.
    longPollMs: 25_000,
    expire: () => 0,
    readDecisions: async () => {
      outstanding += 1;
      if (outstanding > 1) overlaps += 1;
      const duringCycle = inFlight;
      reads.push(duringCycle);
      await new Promise((resolve) => setTimeout(resolve, 5));
      outstanding -= 1;
      if (duringCycle) {
        releaseCycle();
        stop.current = true;
      }
      return [{ id: "g1", state: "approved", decided_by: "telegram:1" }];
    },
  };
  const runCycle = ({ transport: gateChannel }) =>
    new Promise((resolve) => {
      inFlight = true;
      gateChannel.readDecisions().then((seen) => {
        cycleRead = seen;
      });
      releaseCycle = () => {
        inFlight = false;
        resolve();
      };
    });

  await runLoop({ cfg, store: { approvedUnpostedReviews: () => [] }, client: {}, transport, stop, runCycle, now: () => 0, nap: async () => {} });

  assert.ok(reads.includes(true), `the poller stopped asking during the cycle: ${JSON.stringify(reads)}`);
  assert.equal(overlaps, 0, "two getUpdates on one token means 409s and lost decisions");
  assert.deepEqual(cycleRead, [], "the cycle joins the open read instead of opening another");
});
