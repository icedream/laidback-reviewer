/**
 * The run watchdog: when to cancel a prompt of our own.
 *
 * A server that is busy elsewhere keeps a queued request open without ever answering, and it does not
 * say which request is next. A review makes many model requests, so silence is measured from the last
 * thing that happened at all: a queue forming in front of turn seven is the same problem as a queue in
 * front of turn one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ModelBudgetError, ModelBusyError, watchRun } from "../../src/agent/run-watch.mjs";
import { promptWithModelRetry } from "../../src/agent/model-retry.mjs";

class FakeSession {
  constructor() {
    this.aborted = 0;
    this.listeners = [];
    this.prompts = [];
    this.reject = null;
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => this.listeners.splice(this.listeners.indexOf(listener), 1);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async abort() {
    this.aborted += 1;
    this.reject?.();
  }

  prompt(text) {
    this.prompts.push(text);
    return new Promise((_resolve, reject) => {
      this.reject = () => reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
    });
  }
}

/** Clock and timers the test drives, so deadlines are asserted without waiting for them. */
function handClock() {
  const state = { nowMs: 0, armed: new Map(), next: 1 };
  return {
    now: () => state.nowMs,
    advance: (ms) => {
      state.nowMs += ms;
    },
    timer: (fn, ms) => {
      const id = state.next++;
      state.armed.set(id, { fn, ms });
      return id;
    },
    untimer: (id) => state.armed.delete(id),
    // One tick: run whatever is armed, including a tick that re-arms itself.
    tick: async () => {
      const due = [...state.armed.values()];
      state.armed.clear();
      for (const entry of due) await entry.fn();
    },
    armedCount: () => state.armed.size,
  };
}

const busy = { source: "status", busy: true, queued: 1, phase: "reading the prompt", generated: 120, promptTokens: 800 };
const idle = { source: "status", busy: false, queued: 0, phase: "idle", generated: 0, promptTokens: 0 };

function armed({ session, clock, probe = async () => busy, firstTokenMs = 60_000, budgetMs = 0, log = () => {} }) {
  const watch = watchRun({ session, firstTokenMs, budgetMs, probe, log, now: clock.now, timer: clock.timer, untimer: clock.untimer });
  return watch;
}

test("a request that answers nothing while the server works elsewhere is cancelled", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const log = [];
  const watch = armed({ session, clock, log: (line) => log.push(line) });

  clock.advance(60_000);
  await clock.tick();

  assert.equal(session.aborted, 1, "the request is pulled out of the queue");
  assert.deepEqual(watch.state.busy, busy);
  assert.match(log[0], /nothing on the wire for 60s and 1 request\(s\) are queued in front of us/);
});

test("an idle server gets its time on a large prompt", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const watch = armed({ session, clock, probe: async () => idle });

  clock.advance(120_000);
  await clock.tick();

  assert.equal(session.aborted, 0);
  assert.equal(watch.state.busy, null);
  assert.equal(clock.armedCount(), 1, "the check re-arms rather than expiring");
});

test("the hold-off applies at any turn, not only the first", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const log = [];
  const watch = armed({ session, clock, log: (line) => log.push(line) });

  // Turn one and two streamed normally.
  for (const type of ["turn_start", "message_update", "tool_execution_start", "turn_end"]) session.emit({ type });
  clock.advance(20_000);
  await clock.tick();
  assert.equal(session.aborted, 0, "a working session is left alone");

  // Turn seven never starts because something else took the slot.
  session.emit({ type: "turn_start" });
  clock.advance(61_000);
  await clock.tick();

  assert.equal(session.aborted, 1, "a queue that forms mid-review is cancelled too");
  assert.equal(watch.state.reason, "1 request(s) are queued in front of us");
  assert.match(log.at(-1), /nothing on the wire for 61s and 1 request\(s\) are queued/);
});

test("activity keeps resetting the silence", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const watch = armed({ session, clock });

  for (let i = 0; i < 5; i += 1) {
    clock.advance(30_000);
    session.emit({ type: "message_update" });
    await clock.tick();
  }

  assert.equal(session.aborted, 0);
  assert.equal(watch.state.busy, null);
});

test("a server that is simply writing our answer is left alone", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const seen = [];
  const watch = armed({
    session,
    clock,
    // Our own generation: the token counters move between looks, and nothing is queued.
    probe: async () => {
      seen.push(seen.length);
      return { source: "status", busy: true, queued: 0, phase: "thinking", generated: 400 + seen.length * 90, promptTokens: 68000 };
    },
  });

  for (let i = 0; i < 4; i += 1) {
    clock.advance(61_000);
    await clock.tick();
  }

  assert.equal(session.aborted, 0, "moving counters mean the work is ours");
  assert.equal(watch.state.busy, null);
});

test("counters that never move are a stalled client, and that gets cancelled", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const log = [];
  const stuck = { source: "status", busy: true, queued: 0, phase: "reading the prompt", generated: 0, promptTokens: 64254 };
  const watch = armed({ session, clock, probe: async () => stuck, log: (line) => log.push(line) });

  clock.advance(61_000);
  await clock.tick();
  assert.equal(session.aborted, 0, "the first look only leaves a baseline");

  clock.advance(61_000);
  await clock.tick();

  assert.equal(session.aborted, 1);
  assert.match(watch.state.reason, /has produced nothing since/);
});

test("the whole-run budget cancels a review that outstays it", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const log = [];
  const watch = armed({ session, clock, budgetMs: 900_000, probe: async () => idle, log: (line) => log.push(line) });

  clock.advance(900_000);
  await clock.tick();

  assert.equal(watch.state.overBudget, true);
  assert.equal(session.aborted, 1);
  assert.match(log[0], /passed 900s: cancelling it/);
});

test("release disarms the checks so a finished turn cannot be cancelled later", async () => {
  const session = new FakeSession();
  const clock = handClock();
  const watch = armed({ session, clock });

  watch.release();
  clock.advance(600_000);
  await clock.tick();

  assert.equal(session.aborted, 0);
  assert.equal(clock.armedCount(), 0);
});

const cfg = { agent: { model: { busyRetries: 2, busyBackoffMs: 0, firstTokenMs: 2_000 } }, reviews: { budgetMs: 0 } };

test("a cancelled run carries the reason as a typed error", async () => {
  const session = new FakeSession();

  // Real timers here: the watchdog is only interesting when it fires on its own.
  const running = promptWithModelRetry({ session, cfg, collector: { isEmpty: () => true }, prompt: "review this", log: () => {}, probe: async () => busy, sleepImpl: async () => {} });
  const error = await running.catch((caught) => caught);

  assert.ok(error instanceof ModelBusyError, `expected ModelBusyError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.status.phase, "reading the prompt");
  assert.equal(session.aborted, 1, "the retry loop does not re-prompt a busy server");
});

test("the budget surfaces as its own error", () => {
  assert.equal(new ModelBudgetError(60_000).name, "ModelBudgetError");
});
