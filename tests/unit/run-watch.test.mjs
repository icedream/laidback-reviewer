/**
 * The run watchdog: when to cancel a prompt of our own.
 *
 * A server that is busy elsewhere keeps a queued request open without ever answering, and a stalled
 * review holds the slot the interactive session needs. Cancelling is the harness's job because the
 * server will not do it, and a slow first token on an idle server is not a reason to cancel.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ModelBudgetError, ModelBusyError, watchRun } from "../../src/agent/run-watch.mjs";
import { promptWithModelRetry } from "../../src/agent/model-retry.mjs";

class FakeSession {
  constructor({ hang = true, events = [] } = {}) {
    this.hang = hang;
    this.aborted = 0;
    this.listeners = [];
    this.prompts = [];
    this.events = events;
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => this.listeners.splice(this.listeners.indexOf(listener), 1);
  }

  async abort() {
    this.aborted += 1;
  }

  prompt(text) {
    this.prompts.push(text);
    for (const event of this.events) for (const listener of this.listeners) listener(event);
    return this.hang ? new Promise((_resolve, reject) => this.reject = () => reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }))) : Promise.resolve();
  }
}

/** Timers the test fires by hand, so the deadlines do not have to be waited out. */
function handTimers() {
  const armed = new Map();
  let next = 1;
  return {
    armed,
    timer: (fn, ms) => {
      const id = next++;
      armed.set(id, { fn, ms });
      return id;
    },
    untimer: (id) => armed.delete(id),
    fire: async (ms) => {
      for (const [id, entry] of [...armed]) {
        if (entry.ms === ms) {
          armed.delete(id);
          await entry.fn();
        }
      }
    },
  };
}

const busy = { source: "status", busy: true, queued: 0, phase: "reading the prompt" };
const idle = { source: "status", busy: false, queued: 0, phase: "idle" };

test("a request that answers nothing while the server works elsewhere is cancelled", async () => {
  const session = new FakeSession();
  const timers = handTimers();
  const log = [];
  const watch = watchRun({ session, firstTokenMs: 1000, probe: async () => busy, log: (line) => log.push(line), timer: timers.timer, untimer: timers.untimer });

  await timers.fire(1000);

  assert.equal(session.aborted, 1, "the request is pulled out of the queue");
  assert.deepEqual(watch.state.busy, busy);
  assert.match(log[0], /no model output in 1000ms while the server shows reading the prompt/);
});

test("an idle server gets its time on a big prompt", async () => {
  const session = new FakeSession();
  const timers = handTimers();
  const watch = watchRun({ session, firstTokenMs: 1000, probe: async () => idle, timer: timers.timer, untimer: timers.untimer });

  await timers.fire(1000);

  assert.equal(session.aborted, 0);
  assert.equal(watch.state.busy, null);
});

test("once the model is producing, the first-token deadline no longer applies", async () => {
  const session = new FakeSession({ events: [{ type: "message_update" }] });
  const timers = handTimers();
  const watch = watchRun({ session, firstTokenMs: 1000, probe: async () => busy, timer: timers.timer, untimer: timers.untimer });
  session.prompt("review this").catch(() => {});

  await timers.fire(1000);

  assert.equal(session.aborted, 0, "activity means the request reached the slot");
});

test("the whole-run budget cancels a review that outstays it", async () => {
  const session = new FakeSession();
  const timers = handTimers();
  const log = [];
  const watch = watchRun({ session, firstTokenMs: 1000, budgetMs: 5000, probe: async () => idle, log: (line) => log.push(line), timer: timers.timer, untimer: timers.untimer });

  await timers.fire(5000);

  assert.equal(watch.state.overBudget, true);
  assert.equal(session.aborted, 1);
  assert.match(log[0], /passed 5s: cancelling it/);
});

test("release disarms both deadlines so a finished turn cannot be cancelled later", async () => {
  const session = new FakeSession();
  const timers = handTimers();
  const watch = watchRun({ session, firstTokenMs: 1000, budgetMs: 5000, probe: async () => busy, timer: timers.timer, untimer: timers.untimer });

  watch.release();
  await timers.fire(1000);
  await timers.fire(5000);

  assert.equal(session.aborted, 0);
  assert.equal(timers.armed.size, 0);
});

const cfg = { agent: { model: { busyRetries: 2, busyBackoffMs: 0, firstTokenMs: 1000 } }, reviews: { budgetMs: 0 } };

test("a cancelled run carries the reason as a typed error", async () => {
  const session = new FakeSession();
  const original = globalThis.setTimeout;
  const armed = [];
  globalThis.setTimeout = (fn, ms) => {
    armed.push({ fn, ms });
    return armed.length;
  };
  globalThis.clearTimeout = () => {};
  try {
    const running = promptWithModelRetry({ session, cfg, collector: { isEmpty: () => true }, prompt: "review this", log: () => {}, probe: async () => busy, sleepImpl: async () => {} });
    for (const entry of armed.filter((e) => e.ms === 1000)) await entry.fn();
    session.reject?.();
    const error = await running.catch((caught) => caught);
    assert.ok(error instanceof ModelBusyError, `expected ModelBusyError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.status.phase, "reading the prompt");
    assert.equal(session.aborted, 1, "the retry loop does not re-prompt a busy server");
  } finally {
    globalThis.setTimeout = original;
  }
});

test("the budget surfaces as its own error", () => {
  assert.equal(new ModelBudgetError(60_000).name, "ModelBudgetError");
});
