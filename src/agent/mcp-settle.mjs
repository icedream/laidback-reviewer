/**
 * Waiting for configured MCP servers to become usable in a session.
 *
 * The MCP extension connects in the background, so a session created a moment ago may not carry the
 * server's tools yet. A review that prompts at that point asks the model to open a ticket it has no tool
 * for, and the review still posts, which is a silent loss of the only coverage that mattered.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tools of `server` land as `mcp__<server>__<tool>`, with dashes in the name replaced. */
function namespace(server) {
  return `mcp__${String(server).replace(/-/g, "_")}__`;
}

/**
 * Resolves once every configured server has at least one active tool, or the deadline passes.
 * Never throws: a server that stays away degrades the review, and the caller records that as a note.
 */
export async function waitForMcpTools({ session, servers = [], timeoutMs = 8_000, pollMs = 150 }) {
  const started = Date.now();
  if (!servers.length || timeoutMs <= 0) {
    return { waitedMs: 0, ready: [], missing: [...servers], settled: !servers.length };
  }

  const wanted = servers.map((name) => ({ name, prefix: namespace(name) }));
  for (;;) {
    const active = session.getActiveToolNames();
    const ready = wanted.filter((entry) => active.some((tool) => tool.startsWith(entry.prefix)));
    if (ready.length === wanted.length) {
      return { waitedMs: Date.now() - started, ready: ready.map((entry) => entry.name), missing: [], settled: true };
    }
    if (Date.now() - started >= timeoutMs) {
      return {
        waitedMs: Date.now() - started,
        ready: ready.map((entry) => entry.name),
        missing: wanted.filter((entry) => !ready.includes(entry)).map((entry) => entry.name),
        settled: false,
      };
    }
    await sleep(pollMs);
  }
}
