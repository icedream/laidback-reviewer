/**
 * The lab daemon: the small service that actually starts a container for a review.
 *
 * It runs as its own user with its own storage, and it holds no credentials. The harness ships the files a
 * check needs, the daemon runs them under quotas, and both sides record what happened.
 *
 * The runtime is podman today and can be a micro-VM later; only `plan*` and `execute` below know about it.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { LAB_ACTIONS } from "./actions.mjs";

const MAX_COMMAND_OUTPUT = 64_000;

const safeSegment = (value) => String(value ?? "").replace(/[^A-Za-z0-9._/-]/g, "_").replace(/^\/+/, "");

// A name goes into a container name and a tag, so neither may carry a path separator or a shell word.
const safeName = (value) => String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
const safeTag = (value) => String(value ?? "").replace(/[^A-Za-z0-9._:/-]/g, "_");

// An image reference needs its slashes and its tag separator, so it cannot reuse the path sanitizer:
// `docker.io/library/busybox:latest` through safeSegment asks the runtime for busybox_latest.
const safeImage = (value) => {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:/@-]+$/.test(text)) throw new Error(`image reference is not allowed: ${text}`);
  return text;
};

/** A name that cannot collide with something the host already runs. */
export function jobName(jobId, slot = "") {
  return `laidback-${safeName(jobId).slice(0, 24)}${slot ? `-${safeName(slot)}` : ""}`.slice(0, 120);
}

/**
 * A service lives for the session that started it, not for one call, so it is named by the session and the
 * short label the review chose. The label is what the review gets back and passes to exec, logs and down,
 * and it resolves for nobody else's session.
 */
export function servicePrefix(session) {
  return `lb-${safeSegment(session).slice(0, 16)}`;
}

export function serviceName(session, label) {
  return `${servicePrefix(session)}-${safeSegment(label)}`.slice(0, 120);
}

export function serviceLabel(value) {
  const clean = safeSegment(String(value ?? "").toLowerCase());
  return clean || `svc${crypto.randomBytes(3).toString("hex")}`;
}

export function newJobId(now = Date.now()) {
  return `${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

const limitFlags = (limits) => [
  "--cpus", String(limits.cpus ?? 4),
  "--memory", `${limits.memoryMb ?? 4096}m`,
  "--pids-limit", String(limits.pids ?? 512),
];

const networkFor = (egress) => (egress === "none" ? "none" : "laidback-lab");

/**
 * With egress `registries` the only route out is the proxy, so the container is told to use it. The uid
 * rule in `lab/nftables.conf` is what makes that true rather than a suggestion.
 */
function proxyArgs(egress) {
  if (egress !== "registries") return [];
  const proxy = process.env.LAIDBACK_LAB_PROXY ?? "http://host.containers.internal:3128";
  return ["-e", `HTTP_PROXY=${proxy}`, "-e", `HTTPS_PROXY=${proxy}`, "-e", `http_proxy=${proxy}`, "-e", `https_proxy=${proxy}`, "-e", "no_proxy=localhost,127.0.0.1"];
}

/**
 * The argv for one action, with quotas attached and only the job's own directory mounted.
 *
 * @param jobDir directory holding the files the harness shipped, mounted read-only at /work
 */
export function planCommand({ action, params, limits, egress = "registries", jobDir, jobId, session = "" }) {
  const work = path.join(jobDir, "work");
  const mount = `${work}:/work:ro,z`;
  const network = networkFor(egress);
  const cmd = String(params.cmd ?? "").trim();

  switch (action) {
    case "build": {
      const tag = params.image ? safeTag(params.image) : `${jobName(jobId)}-build`;
      const dockerfile = safeSegment(params.dockerfile ?? "Dockerfile");
      // The build reads the staged tree on the host, so the Dockerfile path is the host one.
      return { argv: ["build", "--network", network, "-f", path.join(work, dockerfile), "-t", tag, "-"], cwd: work, stdinTar: true, image: tag };
    }
    case "run": {
      if (!params.image) throw new Error("run needs an image");
      if (!cmd) throw new Error("run needs a command");
      return {
        argv: ["run", "--rm", "--name", jobName(jobId), "--network", network, "-v", mount, ...limitFlags(limits), ...proxyArgs(egress), safeImage(params.image), "sh", "-c", cmd],
        cwd: work,
        image: String(params.image),
      };
    }
    case "start": {
      if (!params.image) throw new Error("start needs an image");
      const env = Object.fromEntries(Object.entries(params.env ?? {}).filter(([name]) => /^[A-Z_][A-Z0-9_]*$/i.test(name)).slice(0, 32));
      const envArgs = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${String(value).slice(0, 512)}`]);
      const label = serviceLabel(params.container);
      const service = serviceName(session || jobId, label);
      return {
        argv: ["run", "-d", "--name", service, "--network", network, "-v", mount, ...envArgs, ...limitFlags(limits), ...proxyArgs(egress), safeImage(params.image), ...(cmd ? ["sh", "-c", cmd] : [])],
        cwd: work,
        image: String(params.image),
        service: label,
      };
    }
    case "exec": {
      if (!cmd) throw new Error("exec needs a command");
      if (!params.container) throw new Error("exec needs the container label that start returned");
      return { argv: ["exec", serviceName(session || jobId, serviceLabel(params.container)), "sh", "-c", cmd], cwd: work };
    }
    case "logs":
      if (!params.container) throw new Error("logs needs the container label that start returned");
      return { argv: ["logs", "--tail", "400", serviceName(session || jobId, serviceLabel(params.container))], cwd: work };
    case "compose": {
      const file = safeSegment(params.compose ?? "compose.yaml");
      if (!cmd) throw new Error("compose needs an action, e.g. up -d");
      return { argv: ["compose", "-f", path.join(work, file), ...cmd.split(/\s+/).map(safeSegment).filter(Boolean)], cwd: work, compose: true };
    }
    case "down":
      return { argv: [], cleanup: true, image: "" };
    default:
      throw new Error(`unknown lab action: ${action}`);
  }
}

/** Runs one podman call, killing it at the wall clock the harness asked for. */
/**
 * What a rootless podman needs from the daemon's own environment to find the invoking user's storage and
 * runtime directories. Nothing else is passed on; a container's own variables travel as `-e` arguments.
 */
const HOST_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "CONTAINERS_STORAGE_CONF", "CONTAINERS_CONF", "XDG_REGISTRIES_CONFIG_HOME",
];

export const hostEnv = () =>
  Object.fromEntries(HOST_ENV_KEYS.map((name) => [name, process.env[name]]).filter(([, value]) => value));

export function executePodman({ binary = "podman", argv, cwd, timeoutMs = 600_000, stdinTar = null }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(binary, argv, { cwd, env: { HOME: "/tmp", TMPDIR: "/tmp", ...hostEnv() }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exit: 127, stdout: "", stderr: `lab runtime could not be started: ${error.message}`, durationMs: 0 });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.toString();
    });
    if (stdinTar && child.stdin) {
      child.stdin.end(stdinTar);
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exit: 127, stdout, stderr: `${stderr}\n${error.message}`.trim(), durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit: timedOut ? 124 : (code ?? 0),
        stdout: stdout.slice(0, MAX_COMMAND_OUTPUT),
        stderr: timedOut ? `${stderr}\nlab job exceeded its wall clock`.trim() : stderr.slice(0, MAX_COMMAND_OUTPUT),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** Containers this job may have left behind, and its scratch directory. Services outlive the call that
 * started them, so only `down` sweeps the session's whole set. */
export async function cleanupJob({ run, jobId, jobDir, session = "", sweepServices = false, log = () => {} }) {
  const filters = [`name=${jobName(jobId)}`];
  if (sweepServices && session) filters.push(`name=${servicePrefix(session)}`);
  const names = new Set();
  for (const filter of filters) {
    const listed = await run(["ps", "-a", "--filter", filter, "--format", "{{.Names}}"], { timeoutMs: 30_000 });
    for (const name of String(listed.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)) names.add(name);
  }
  for (const name of names) {
    await run(["rm", "-f", name], { timeoutMs: 30_000 });
    log(`lab ${jobId}: removed ${name}`);
  }
  try {
    fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (error) {
    log(`lab ${jobId}: ${jobDir} could not be removed: ${error.message}`);
  }
}

/**
 * Write what the harness shipped into the job directory. Contents arrive inline, so the lab user never
 * needs read access to the bot's scratch tree.
 */
export function stageJob({ jobDir, files = [], contextTar = null, maxFileBytes = 512_000, maxTotalBytes = 4_000_000 }) {
  const work = path.join(jobDir, "work");
  fs.mkdirSync(work, { recursive: true });
  let written = 0;
  const skipped = [];
  for (const file of files) {
    const contents = String(file?.contents ?? "");
    const target = path.resolve(work, safeSegment(file?.path ?? ""));
    if (!target.startsWith(path.resolve(work))) {
      skipped.push(`${file?.path}: outside the job directory`);
      continue;
    }
    if (contents.length > maxFileBytes || written + contents.length > maxTotalBytes) {
      skipped.push(`${file?.path}: over the size limit`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    written += contents.length;
  }
  if (contextTar) {
    fs.writeFileSync(path.join(jobDir, "context.tar"), Buffer.from(contextTar, "base64"));
  }
  return { work, written, skipped };
}

/**
 * The request handler, separate from the server so a test can drive it without a socket.
 *
 * @param run runs one runtime call; inject a fake to test without a container runtime
 */
export function createLabHandler({ limits, egress = "registries", workspace = "/var/lib/laidback-lab", token = "", run, log = () => {}, cleanup = cleanupJob, keepRunningMs = 3 * 60 * 60 * 1000 }) {
  let running = 0;
  const queued = [];

  const slot = async () => {
    if (running >= (limits.concurrency ?? 1)) {
      await new Promise((resolve) => queued.push(resolve));
    }
    running += 1;
    return () => {
      running -= 1;
      const next = queued.shift();
      if (next) next();
    };
  };

  return async function handle(req, res) {
    const action = String(req.url ?? "").replace(/^\//, "").split("?")[0];
    if (!LAB_ACTIONS.includes(action)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unknown lab action: ${action}` }));
      return;
    }
    if (token) {
      const given = String(req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "lab token missing or wrong" }));
        return;
      }
    }

    let params = {};
    try {
      const raw = await readBody(req);
      params = raw ? JSON.parse(raw) : {};
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `request body could not be read: ${error.message}` }));
      return;
    }

    const jobId = safeSegment(params.job ?? newJobId());
    const jobDir = path.join(workspace, jobId);
    const release = await slot();
    let result;
    try {
      fs.mkdirSync(jobDir, { recursive: true });
      const staged = stageJob({ jobDir, files: params.files, contextTar: params.contextTar });
      if (staged.skipped.length) log(`lab ${jobId}: ${staged.skipped.join("; ")}`);

      const plan = planCommand({ action, params, limits, egress, jobDir, jobId, session: params.session ?? "" });
      if (plan.cleanup) {
        await cleanup({ run, jobId, jobDir, session: params.session ?? "", sweepServices: true, log });
        result = { exit: 0, stdout: "job containers removed", stderr: "", durationMs: 0, image: "" };
      } else {
        const started = Date.now();
        if (plan.compose && !(await runtimeHas({ run, subcommand: "compose" }))) {
          result = { exit: 127, stdout: "", stderr: "this lab has no compose support", durationMs: 0, image: params.image ?? "" };
        } else {
          const output = await run(plan.argv, {
            cwd: plan.cwd,
            timeoutMs: limits.timeoutMs ?? limits.jobTimeoutMs ?? 600_000,
            stdinTar: plan.stdinTar && params.contextTar ? fs.readFileSync(path.join(jobDir, "context.tar")) : null,
          });
          result = { ...output, image: plan.image ?? params.image ?? "", ...(plan.service ? { service: plan.service } : {}) };
        }
        log(`lab ${jobId} ${action}: exit ${result.exit} in ${Date.now() - started}ms`);
        // Only a call that ran to completion in one go leaves nothing behind. A service started for exec
        // and logs must survive the inspecting calls, or the second look finds an empty host.
        if (action === "run" || action === "build") await cleanup({ run, jobId, jobDir, log });
      }
    } catch (error) {
      result = { exit: 1, stdout: "", stderr: error.message, durationMs: 0, image: "" };
      log(`lab ${jobId} ${action}: ${error.message}`);
    } finally {
      release();
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ job: jobId, ...result }));
  };
}

async function runtimeHas({ run, subcommand }) {
  const probe = await run([subcommand, "--help"], { timeoutMs: 15_000 });
  return probe.exit === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64_000_000) {
        reject(new Error("request body over 64 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the daemon. Kept separate from the module side effects so tests import it freely. */
export function startLabDaemon({ port = 9443, host = "127.0.0.1", token = process.env.LAIDBACK_LAB_TOKEN ?? "", workspace = process.env.LAIDBACK_LAB_WORKSPACE ?? "/var/lib/laidback-lab", limits = {}, egress = process.env.LAIDBACK_LAB_EGRESS ?? "registries", binary = "podman", log = (line) => console.log(line) } = {}) {
  const run = (argv, options) => executePodman({ binary, argv, ...options });
  const handler = createLabHandler({ limits: { ...limits, jobTimeoutMs: limits.jobTimeoutMs ?? 600_000 }, egress, workspace, token, run, log });
  const server = http.createServer(handler);
  server.listen(port, host, () => log(`lab daemon on http://${host}:${port} (runtime ${binary}, egress ${egress}, workspace ${workspace})`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? def : args[index + 1];
  };
  startLabDaemon({
    port: Number(flag("port", 9443)),
    host: flag("host", "127.0.0.1"),
    workspace: flag("workspace", process.env.LAIDBACK_LAB_WORKSPACE ?? "/var/lib/laidback-lab"),
    egress: flag("egress", process.env.LAIDBACK_LAB_EGRESS ?? "registries"),
    binary: flag("binary", "podman"),
    limits: {
      cpus: Number(flag("cpus", 4)),
      memoryMb: Number(flag("memory", 4096)),
      diskMb: Number(flag("disk", 20480)),
      pids: Number(flag("pids", 512)),
      jobTimeoutMs: Number(flag("timeout-ms", 600_000)),
      concurrency: Number(flag("concurrency", 1)),
    },
  });
}
