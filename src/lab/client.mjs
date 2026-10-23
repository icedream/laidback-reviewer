/**
 * The lab: somewhere a review can run a check that needs a running thing.
 *
 * The harness owns this door. The agent's shell keeps its denial of docker, podman and kubectl, so every
 * container action arrives here, with the limits attached and the outcome recorded. The daemon behind the
 * URL is a separate concern, and the backend can change (rootless podman today, a micro-VM per job later)
 * without the tool's shape changing.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LAB_ACTIONS } from "./actions.mjs";

export function labEnabled(cfg) {
  return cfg?.lab?.enabled === true && Boolean(cfg?.lab?.url);
}

/**
 * @param env environment for the daemon token, so a test does not have to touch the process environment
 */
export function createLabClient({ cfg, env = process.env, staging = {}, log = () => {}, fetchImpl = fetch }) {
  const lab = cfg.lab ?? {};
  if (!labEnabled(cfg)) return null;

  const base = String(lab.url).replace(/\/+$/, "");
  const token = String(env[lab.tokenEnv ?? "LAIDBACK_LAB_TOKEN"] ?? "");

  /**
   * Read what the call names into the request, so the lab user never needs access to the run's tree.
   * Only paths under the run's own roots are staged, and the total is capped.
   */
  /**
   * A review names staged files from wherever it happens to be standing, so a path relative to its scratch
   * tree is the common case. Try the name as given, then under each staging root, and keep only a result
   * that stays inside a root.
   */
  function locate(name, mustExist = false) {
    const roots = (staging.roots ?? []).map((root) => path.resolve(root));
    const given = String(name);
    const stripped = given.replace(/^\.?\/?scratch\//, "");
    const candidates = [path.resolve(given), ...roots.map((root) => path.resolve(root, given))];
    if (stripped !== given) candidates.push(...roots.map((root) => path.resolve(root, stripped)));
    for (const candidate of candidates) {
      const root = roots.find((each) => candidate === each || candidate.startsWith(`${each}/`));
      if (!root) continue;
      if (!mustExist || fs.existsSync(candidate)) return { path: candidate, root };
    }
    return null;
  }

  function stage(files = [], context = "") {
    const roots = staging.roots ?? [];
    const staged = [];
    const refused = [];
    let total = 0;
    for (const name of files) {
      const found = locate(name, true) ?? locate(name);
      if (!found) {
        refused.push(`${name}: not inside this run's scratch, give it relative to ${roots[0] ?? "the scratch root"}`);
        continue;
      }
      const resolved = found.path;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        refused.push(`${name}: not a file`);
        continue;
      }
      const size = fs.statSync(resolved).size;
      if (size > 512_000 || total + size > 4_000_000) {
        refused.push(`${name}: over the staged size limit`);
        continue;
      }
      staged.push({ path: path.relative(found.root, resolved) || path.basename(resolved), contents: fs.readFileSync(resolved, "utf8") });
      total += size;
    }
    return { files: staged, refused };
  }

  /** A whole directory as a tarball, for a build context. Capped, and only from this run's scratch. */
  async function stageContext(dir) {
    const roots = staging.roots ?? [];
    const found = locate(dir);
    if (!found) return { refused: `${dir}: not inside this run's scratch, give it relative to ${roots[0] ?? "the scratch root"}` };
    const resolved = found.path;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { refused: `${dir}: not a directory` };
    const capMb = lab.maxContextMb ?? 30;
    const child = spawn("tar", ["-C", resolved, "--exclude", ".git", "-czf", "-", "."]);
    const chunks = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > capMb * 1024 * 1024) {
        child.kill();
        return { refused: `${dir}: build context over ${capMb} MB` };
      }
      chunks.push(chunk);
    }
    const code = await new Promise((resolve) => child.on("close", resolve));
    if (code !== 0) return { refused: `${dir}: could not be packed` };
    return { contextTar: Buffer.concat(chunks).toString("base64") };
  }

  async function call(action, payload) {
    const startedAt = Date.now();
    if (!LAB_ACTIONS.includes(action)) return { ok: false, error: `unknown lab action: ${action}` };

    const { files, refused } = stage(payload.files ?? [], payload.context);
    const context = payload.context ? await stageContext(payload.context) : {};
    const blocked = [...refused, ...(context.refused ? [context.refused] : [])];
    if (blocked.length) return { ok: false, error: `lab ${action} staged nothing: ${blocked.join("; ")}` };

    let response;
    try {
      response = await fetchImpl(`${base}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        // The daemon enforces the job ceiling; this only stops the harness waiting forever on a dead one.
        signal: AbortSignal.timeout(Math.max(lab.jobTimeoutMs ?? 600_000, 10_000) + 30_000),
        body: JSON.stringify({
          ...payload,
          session: staging.session ?? "",
          files,
          contextTar: context.contextTar,
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
      ...(body?.service ? { service: String(body.service) } : {}),
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
