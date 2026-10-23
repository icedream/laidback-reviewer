/**
 * The lab: somewhere a review can run a check that needs a running thing.
 *
 * The harness owns this door. The agent's shell keeps its denial of docker, podman and kubectl, so every
 * container action arrives here, with the limits attached and the outcome recorded. The daemon behind the
 * URL is a separate concern, and the backend can change (rootless podman today, a micro-VM per job later)
 * without the tool's shape changing.
 */

export const LAB_ACTIONS = ["build", "run", "exec", "logs", "compose", "down"];

export function labEnabled(cfg) {
  return cfg?.lab?.enabled === true && Boolean(cfg?.lab?.url);
}

/**
 * @param env environment for the daemon token, so a test does not have to touch the process environment
 */
export function createLabClient({ cfg, env = process.env, log = () => {}, fetchImpl = fetch }) {
  const lab = cfg.lab ?? {};
  if (!labEnabled(cfg)) return null;

  const base = String(lab.url).replace(/\/+$/, "");
  const token = String(env[lab.tokenEnv ?? "LAIDBACK_LAB_TOKEN"] ?? "");

  async function call(action, payload) {
    const startedAt = Date.now();
    if (!LAB_ACTIONS.includes(action)) return { ok: false, error: `unknown lab action: ${action}` };

    let response;
    try {
      response = await fetchImpl(`${base}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        // The daemon enforces the job ceiling; this only stops the harness waiting forever on a dead one.
        signal: AbortSignal.timeout(Math.max(lab.jobTimeoutMs ?? 600_000, 10_000) + 30_000),
        body: JSON.stringify({
          ...payload,
          limits: { cpus: lab.cpus, memoryMb: lab.memoryMb, diskMb: lab.diskMb, pids: lab.pids, timeoutMs: lab.jobTimeoutMs },
          egress: lab.egress,
        }),
      });
    } catch (error) {
      log(`lab ${action} failed to reach ${base}: ${error.message}`);
      return { ok: false, error: `lab daemon unreachable: ${error.message}` };
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = body?.error ?? `HTTP ${response.status}`;
      log(`lab ${action} refused: ${reason}`);
      return { ok: false, error: `lab refused ${action}: ${reason}` };
    }
    return {
      ok: true,
      action,
      exit: Number(body?.exit ?? 0),
      stdout: String(body?.stdout ?? "").slice(0, 4000),
      stderr: String(body?.stderr ?? "").slice(0, 2000),
      image: String(body?.image ?? payload.image ?? ""),
      jobId: String(body?.job ?? ""),
      durationMs: Number(body?.durationMs ?? Date.now() - startedAt),
      egress: lab.egress ?? "registries",
    };
  }

  return { call, actions: LAB_ACTIONS };
}

/** How a lab call reads in the gate table, which is where an operator checks it afterwards. */
export function labGateRow(action, params, result) {
  const target = params.image || params.dockerfile || params.context || action;
  const label = `lab ${action}: ${target}${params.label ? ` (${params.label})` : ""}`;
  if (!result.ok) return { gate: label, result: "not_run", evidence: result.error };
  const outcome = result.exit === 0 ? "pass" : "fail";
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
  const evidence =
    `job ${result.jobId || "-"} at ${result.durationMs}ms, exit ${result.exit}, egress ${result.egress}, image ${result.image || "-"}` +
    (output ? `: ${output.slice(0, 900)}` : "");
  return { gate: label, result: outcome, evidence };
}
