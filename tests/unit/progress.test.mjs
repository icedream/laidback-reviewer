/**
 * Console progress for a running review.
 *
 * A review takes minutes and does most of it silently inside the model. The heartbeat and the tool lines
 * are what tell an operator that the run is working rather than stuck, and which gate result it is
 * waiting on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createProgress, elapsedLabel } from "../../src/agent/progress.mjs";

function harness({ mode = "tools", heartbeatMs = 10_000 } = {}) {
  const lines = [];
  const armed = new Map();
  const clock = { nowMs: 0, next: 1 };
  const progress = createProgress({
    log: (line) => lines.push(line),
    mode,
    heartbeatMs,
    startedAt: 0,
    now: () => clock.nowMs,
    timer: (fn, ms) => {
      const id = clock.next++;
      armed.set(id, { fn, ms });
      return id;
    },
    untimer: (id) => armed.delete(id),
  });

  return {
    lines,
    progress,
    advance: (ms) => {
      clock.nowMs += ms;
    },
    beat: async () => {
      const due = [...armed.values()];
      armed.clear();
      for (const entry of due) await entry.fn();
    },
    armedCount: () => armed.size,
  };
}

test("a tool call is printed as it starts, with the argument that matters", () => {
  const h = harness();

  h.progress.handle({ type: "tool_execution_start", toolName: "bash", args: { command: "cd /work/scratch/x && go test ./..." } });
  h.progress.handle({ type: "tool_execution_start", toolName: "review_propose_comment", args: { path: "go.mod", line: 119 } });

  assert.equal(h.lines.length, 2);
  assert.match(h.lines[0], /^\[\d\d:\d\d\] tool bash command=cd \/work\/scratch\/x && go test \.\/\.\.\./);
  assert.match(h.lines[1], /tool review_propose_comment path=go\.mod/);
  assert.equal(h.progress.state.toolCalls, 2);
});

test("a long command is shortened rather than dumped", () => {
  const h = harness();
  h.progress.handle({ type: "tool_execution_start", toolName: "bash", args: { command: `echo ${"x".repeat(400)}` } });

  assert.ok(h.lines[0].length < 160, `the line stays readable: ${h.lines[0].length} chars`);
});

test("a heartbeat names the activity while the model is thinking", async () => {
  const h = harness();

  h.progress.handle({ type: "turn_start" });
  h.advance(15_000);
  await h.beat();

  assert.match(h.lines[0], /still working: thinking, 0 tool call\(s\)$/);
  assert.equal(h.armedCount(), 1, "the heartbeat re-arms instead of expiring");
});

test("token usage accumulates from the model's own counts", async () => {
  const h = harness();

  h.progress.handle({ type: "message_end", message: { usage: { input_tokens: 1200, output_tokens: 300 } } });
  h.progress.handle({ type: "message_end", message: { usage: { input_tokens: 1500, output_tokens: 200 } } });
  await h.beat();

  assert.equal(h.progress.state.tokens, 3200);
  assert.match(h.lines[0], /3\.2k tokens/);
});

test("full mode says how each tool call ended", () => {
  const h = harness({ mode: "full" });

  h.progress.handle({ type: "tool_execution_start", toolName: "bash", args: { command: "go test ./..." } });
  h.progress.handle({ type: "tool_execution_end", toolName: "bash", isError: false, durationMs: 1234 });
  h.progress.handle({ type: "tool_execution_end", toolName: "read", isError: true });

  assert.match(h.lines[1], /bash done in 1\.2s/);
  assert.match(h.lines[2], /read failed/);
});

test("progress off keeps the state and says nothing", async () => {
  const h = harness({ mode: "off" });

  h.progress.handle({ type: "tool_execution_start", toolName: "bash", args: { command: "go test ./..." } });
  await h.beat();

  assert.deepEqual(h.lines, []);
  assert.equal(h.progress.state.toolCalls, 1, "off silences the log, not the state: the gate display reads it");
  assert.equal(h.progress.state.phase, "tool bash");
  assert.equal(h.armedCount(), 0, "no heartbeat is armed at all");
});

test("stop disarms the heartbeat so a finished run cannot print later", async () => {
  const h = harness();

  h.progress.stop();
  await h.beat();

  assert.deepEqual(h.lines, []);
});

test("the elapsed label is minutes and seconds", () => {
  assert.equal(elapsedLabel(0, 0), "00:00");
  assert.equal(elapsedLabel(95_000, 0), "01:35");
  assert.equal(elapsedLabel(3_600_000, 0), "60:00");
});

test("the running state is offered to a second consumer without changing the log", () => {
  const seen = [];
  const logs = [];
  const timers = [];
  const progress = createProgress({
    log: (line) => logs.push(line),
    mode: "tools",
    heartbeatMs: 1_000,
    timer: (fn) => timers.push(fn),
    untimer: () => {},
    onState: (state) => seen.push({ phase: state.phase, toolCalls: state.toolCalls }),
  });
  progress.handle({ type: "tool_execution_start", toolName: "read", args: { path: "go.mod" } });
  progress.handle({ type: "message_end", message: { usage: { input_tokens: 900, output_tokens: 100 } } });
  progress.stop();
  assert.deepEqual(seen.map((entry) => entry.phase), ["tool read", "writing"]);
  assert.equal(seen.at(-1).toolCalls, 1);
  assert.deepEqual(logs, ["[00:00] tool read path=go.mod"]);
});

test("state is still tracked when the log stream is off", () => {
  const seen = [];
  const progress = createProgress({ mode: "off", onState: (state) => seen.push(state.phase) });
  progress.handle({ type: "tool_execution_start", toolName: "bash", args: { command: "go test ./..." } });
  assert.equal(seen.length, 1);
  assert.equal(progress.state.toolCalls, 1);
});
