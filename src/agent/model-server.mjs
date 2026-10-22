/**
 * Is the inference server free enough to take a prompt?
 *
 * A home server runs one prompt at a time and queues the next one on the same connection, so a bot that
 * sends a request anyway occupies a slot and waits minutes without producing anything. The status shape
 * is per server: Strata answers on /status, llama.cpp on /slots?model=, and a plain OpenAI endpoint
 * offers neither. The strategy that answered is remembered, so the probe costs one request per cycle.
 */

import fs from "node:fs";
import path from "node:path";

/** `http://host:11182/v1` -> `http://host:11182`, where the server's own endpoints live. */
export function serverRoot(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The provider's base URL and key as Pi knows them, read from models.json. */
export function resolveModelServer({ piAgentDir, provider, modelId, statusUrl = "" }) {
  const file = path.join(piAgentDir ?? "", "models.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const entry = (parsed?.providers ?? {})[provider];
  if (!entry?.baseUrl) return null;
  return { baseUrl: entry.baseUrl, apiKey: entry.apiKey ?? "", modelId, statusUrl: statusUrl || "" };
}

async function getJson(url, { apiKey, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

export async function statusProbe({ root, apiKey, timeoutMs = 3000, fetchImpl = fetch }) {
  const body = await getJson(`${root}/status`, { apiKey, timeoutMs, fetchImpl });
  if (!body || typeof body.busy !== "boolean") return null;
  const queued = Number(body.queued ?? 0);
  const number = (value) => (typeof value === "number" ? value : undefined);
  return {
    source: "status",
    busy: body.busy || queued > 0,
    queued,
    phase: String(body.phase ?? ""),
    // These two say whether the server is moving, which is how a request of ours that is simply
    // generating is told apart from a client that stopped sending.
    generated: number(body.generated),
    promptTokens: number(body.prompt_tokens),
  };
}

export async function slotsProbe({ root, apiKey, model, timeoutMs = 3000, fetchImpl = fetch }) {
  if (!model) return null;
  const url = `${root}/slots?${new URLSearchParams({ model })}`;
  const body = await getJson(url, { apiKey, timeoutMs, fetchImpl });
  if (!Array.isArray(body)) return null;
  const processing = body.filter((slot) => slot?.is_processing).length;
  return { source: "slots", busy: processing > 0, queued: 0, phase: processing ? `${processing}/${body.length} slots processing` : "slots idle" };
}
/**
 * No status endpoint: ask for one token and see how fast it answers. A slow answer means the slot is
 * taken; an unreachable server is reported separately, because that is a failure rather than a queue.
 */
export async function latencyProbe({ root, apiKey, model, maxWaitMs = 2500, fetchImpl = fetch }) {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${root}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(maxWaitMs),
    });
    if (!response.ok) return null;
    await response.text().catch(() => "");
    return { source: "latency", busy: false, queued: 0, phase: `answered in ${Date.now() - started}ms` };
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      return { source: "latency", busy: true, queued: 0, phase: `no answer within ${maxWaitMs}ms` };
    }
    return null;
  }
}

const STRATEGIES = [statusProbe, slotsProbe, latencyProbe];
const BY_MODE = { status: statusProbe, slots: slotsProbe, latency: latencyProbe };
const MODE_NAMES = new Map([[statusProbe, "status"], [slotsProbe, "slots"], [latencyProbe, "latency"]]);
const chosen = new Map();

/**
 * Ask the server what it is doing. `mode` pins one strategy; "auto" tries the one that worked last
 * time first. No answer is not treated as busy: a bot that cannot read the queue still sends its
 * request and lets the run watchdog decide.
 */
export async function modelServerStatus({ server, mode = "auto", probeTimeoutMs = 3000, latencyMs = 2500, fetchImpl = fetch }) {
  if (!server || mode === "none") return { source: "none", busy: false, queued: 0, phase: "probe disabled" };

  const root = server.statusUrl ? String(server.statusUrl).replace(/\/status$/, "") : serverRoot(server.baseUrl);
  const remembered = chosen.get(root);
  const order = mode === "auto" ? (remembered ? [remembered, ...STRATEGIES.filter((probe) => probe !== remembered)] : STRATEGIES) : [BY_MODE[mode]].filter(Boolean);
  const tried = [];

  for (const probe of order) {
    let result = null;
    try {
      result = await probe({
        root,
        apiKey: server.apiKey,
        model: server.modelId,
        timeoutMs: probe === latencyProbe ? latencyMs : probeTimeoutMs,
        maxWaitMs: latencyMs,
        fetchImpl,
      });
    } catch (error) {
      tried.push(`${MODE_NAMES.get(probe)}: ${error.message}`);
      continue;
    }
    if (result) {
      chosen.set(root, probe);
      return result;
    }
    tried.push(`${MODE_NAMES.get(probe)}: no answer`);
  }

  return { source: "unknown", busy: false, queued: 0, phase: tried.join("; "), error: "no probe answered" };
}
