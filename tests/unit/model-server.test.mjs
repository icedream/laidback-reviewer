/**
 * Reading the inference server's queue before adding to it.
 *
 * A shared home server runs one prompt at a time, and a request that is queued still occupies a
 * connection. Each server describes itself differently: Strata has /status, llama.cpp has per-slot
 * state, and a plain OpenAI endpoint has neither, which leaves timing a one-token request.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelServerStatus, resolveModelServer, serverRoot, slotsProbe, statusProbe, latencyProbe } from "../../src/agent/model-server.mjs";
import { slotOccupancy } from "../../src/agent/model-server.mjs";

const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

/** A fetch that answers with `payload`, or hangs until its signal aborts. */
function fakeFetch({ json, status = 200, hang = false, recorded = [] }) {
  return async (url, options = {}) => {
    recorded.push(url);
    if (hang) {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(abortError()));
      });
    }
    return { ok: status === 200, status, json: async () => json, text: async () => JSON.stringify(json ?? "") };
  };
}

test("the api path is stripped to reach the server's own endpoints", () => {
  assert.equal(serverRoot("http://198.51.100.7:8080/v1"), "http://198.51.100.7:8080");
  assert.equal(serverRoot("http://198.51.100.7:8080/"), "http://198.51.100.7:8080");
});

test("strata says what it is doing", async () => {
  const fetched = [];
  const probe = await statusProbe({
    root: "http://strata.invalid",
    apiKey: "k",
    fetchImpl: fakeFetch({ json: { busy: true, queued: 0, phase: "reading the prompt", prompt_tokens: 64362 } , recorded: fetched }),
  });

  assert.equal(probe.busy, true);
  assert.equal(probe.phase, "reading the prompt");
  assert.match(fetched[0], /\/status$/);
});

test("a queued request counts as busy even when the slot is idle", async () => {
  const probe = await statusProbe({ root: "http://strata2.invalid", apiKey: "k", fetchImpl: fakeFetch({ json: { busy: false, queued: 2 } }) });
  assert.equal(probe.busy, true);
  assert.equal(probe.queued, 2);
});

test("llama.cpp answers on the slot list instead", async () => {
  const fetched = [];
  const busy = await slotsProbe({
    root: "http://llama.invalid",
    apiKey: "",
    model: "qwen3.8-27b",
    fetchImpl: fakeFetch({ json: [{ id: 0, is_processing: true }, { id: 1, is_processing: false }], recorded: fetched }),
  });

  assert.equal(busy.busy, true);
  assert.equal(busy.phase, "1/2 slots processing");
  assert.match(fetched[0], /\/slots\?model=qwen3\.8-27b$/);

  const idle = await slotsProbe({ root: "http://llama.invalid", model: "qwen3.8-27b", fetchImpl: fakeFetch({ json: [{ id: 0, is_processing: false }] }) });
  assert.equal(idle.busy, false);
});

test("without a status endpoint the only honest probe is timing one token", async () => {
  const quick = await latencyProbe({ root: "http://plain.invalid", model: "m", fetchImpl: fakeFetch({ json: { choices: [] } }) });
  assert.equal(quick.busy, false);
  assert.match(quick.phase, /answered in \d+ms/);

  const slow = await latencyProbe({ root: "http://slow.invalid", model: "m", maxWaitMs: 40, fetchImpl: fakeFetch({ hang: true }) });
  assert.equal(slow.busy, true);
  assert.match(slow.phase, /no answer within 40ms/);
});

test("an unreachable server is not reported as busy", async () => {
  const result = await modelServerStatus({
    server: { baseUrl: "http://down.invalid/v1", apiKey: "", modelId: "m" },
    mode: "latency",
    latencyMs: 40,
    fetchImpl: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    },
  });

  assert.equal(result.busy, false);
  assert.equal(result.error, "no probe answered");
});

test("auto tries the strategy that answered last time first", async () => {
  const answer = { busy: false, queued: 0, phase: "idle" };
  const fetched = [];
  const server = { baseUrl: "http://both.invalid/v1", apiKey: "k", modelId: "m" };
  const fetchImpl = fakeFetch({ json: answer, recorded: fetched });

  await modelServerStatus({ server, mode: "auto", fetchImpl });
  const firstRound = fetched.slice();
  fetched.length = 0;
  await modelServerStatus({ server, mode: "auto", fetchImpl });

  assert.match(firstRound[0], /\/status$/, "status is the first attempt");
  assert.match(fetched[0], /\/status$/, "and it stays first once it has answered");
  assert.equal(fetched.length, 1, "one request per cycle once the strategy is known");
});

test("probe none leaves the queue unread", async () => {
  const result = await modelServerStatus({ server: { baseUrl: "http://x.invalid/v1" }, mode: "none", fetchImpl: fakeFetch({ json: {} }) });
  assert.deepEqual(result, { source: "none", busy: false, queued: 0, phase: "probe disabled" });
});

test("the provider's URL and key come from the models.json Pi reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-models-"));
  try {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: { "home/strata": { baseUrl: "http://198.51.100.9:8080/v1", apiKey: "secret" } } }),
    );

    const server = resolveModelServer({ piAgentDir: dir, provider: "home/strata", modelId: "qwen" });
    assert.equal(server.baseUrl, "http://198.51.100.9:8080/v1");
    assert.equal(server.apiKey, "secret");
    assert.equal(resolveModelServer({ piAgentDir: dir, provider: "home/absent" }), null);
    assert.equal(resolveModelServer({ piAgentDir: path.join(dir, "nope"), provider: "home/strata" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the slot numbers say what a resumed pass would have to recompute", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [
        { id: 0, n_ctx: 393216, is_processing: false, n_prompt_tokens: 41208 },
        { id: 1, n_ctx: 393216, is_processing: true, n_prompt_tokens: 900 },
      ],
    };
  };

  const occupancy = await slotOccupancy({ root: "http://127.0.0.1:8080", apiKey: "k", model: "qwen", fetchImpl });
  assert.deepEqual(occupancy, { promptTokens: 41208, slotCount: 2, processing: 1 });
  assert.match(seen[0], /\/slots\?model=qwen&autoload=false/, "a question about a slot must not load a model");

  const quiet = await slotOccupancy({
    root: "http://127.0.0.1:8080",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ id: 0, is_processing: false }] }),
  });
  assert.equal(quiet.promptTokens, null, "a server that does not report the number says so rather than zero");

  const refused = await slotOccupancy({ root: "http://127.0.0.1:8080", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: "nope" }) }) });
  assert.equal(refused, null);
});
