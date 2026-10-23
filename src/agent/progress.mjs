/**
 * What the session is doing, as it happens.
 *
 * A review can take ten minutes, and quiet during that time is indistinguishable from a hang. The agent
 * already emits tool and turn events, so the cost of showing them is a subscriber and a heartbeat for the
 * thinking stretches in between.
 */

const DETAIL_KEYS = ["command", "path", "url", "query", "pattern", "server", "tool", "taskId"];

export function elapsedLabel(now, startedAt) {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function detailOf(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return `${key}=${value.replace(/\s+/g, " ").slice(0, 110)}`;
  }
  const position = [args.path, args.line].filter((value) => value !== undefined);
  return position.length ? position.join(":") : "";
}

/**
 * Returns { handle, state, stop }. Subscribe `handle` to the session and call `stop()` when the run
 * ends. `mode: "off"` still tracks state, it just says nothing.
 */
export function createProgress({ log = () => {}, mode = "tools", heartbeatMs = 15_000, startedAt = Date.now(), now = () => Date.now(), timer = setTimeout, untimer = clearTimeout, onState = null }) {
  const state = { toolCalls: 0, tokens: 0, phase: "starting", lastEventAt: startedAt };
  const inFlight = new Map();

  // A tool call in flight is the whole story of a quiet run: the model is waiting, the inference server
  // has nothing to do, and "still working: tool bash" says none of that.
  const runningNote = () => {
    if (!inFlight.size) return "";
    const [first] = inFlight.values();
    const waited = Math.max(0, Math.round((now() - first.at) / 1000));
    const extra = inFlight.size > 1 ? ` (+${inFlight.size - 1} more)` : "";
    return `${first.name}${first.detail ? ` ${first.detail}` : ""} running ${waited}s${extra}`;
  };

  const report = () => onState?.(state);
  const quiet = mode === "off";
  const stamp = () => elapsedLabel(now(), startedAt);
  // Off silences the log, not the tracking: the gate display in the chat reads the same state.
  const say = quiet ? () => {} : (text) => log(`[${stamp()}] ${text}`);

  const handle = (event) => {
    if (!event?.type) return;
    state.lastEventAt = now();

    switch (event.type) {
      case "turn_start":
        state.phase = "thinking";
        report();
        break;
      case "message_end": {
        const usage = event.message?.usage;
        if (usage) state.tokens += Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
        state.phase = "writing";
        report();
        break;
      }
      case "tool_execution_start":
        state.toolCalls += 1;
        state.phase = `tool ${event.toolName}`;
        state.lastDetail = detailOf(event.args);
        inFlight.set(event.toolCallId ?? `${event.toolName}:${state.toolCalls}`, { name: event.toolName, detail: state.lastDetail, at: now() });
        say(`${state.phase}${state.lastDetail ? ` ${state.lastDetail}` : ""}`);
        report();
        break;
      case "tool_execution_end":
        inFlight.delete(event.toolCallId ?? "");
        // Once nothing is in flight the phase must stop naming a call that finished.
        if (!inFlight.size) state.phase = `tool ${event.toolName}`;
        if (mode !== "full") break;
        say(`    ${event.toolName} ${event.isError ? "failed" : "done"}${typeof event.durationMs === "number" ? ` in ${Math.round(event.durationMs / 100) / 10}s` : ""}`);
        break;
    }
  };

  let heartbeat = null;
  const beat = () => {
    // Some local providers report no usage, and "0k tokens" then reads like a bug rather than a gap.
    const tokenNote = state.tokens ? `, ${Math.round(state.tokens / 100) / 10}k tokens` : "";
    const running = runningNote();
    if (running) state.phase = `waiting on ${running}`;
    say(`${running ? "waiting on" : "still working:"} ${running || state.phase}, ${state.toolCalls} tool call(s)${tokenNote}`);
    heartbeat = timer(beat, heartbeatMs);
    report();
  };
  if (!quiet) heartbeat = timer(beat, heartbeatMs);

  return {
    handle,
    state,
    stop() {
      if (heartbeat) untimer(heartbeat);
      heartbeat = null;
    },
  };
}
