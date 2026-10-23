/**
 * The lab daemon, tested without a container runtime.
 *
 * What has to hold: the quotas reach the runtime, a job leaves nothing behind unless it asked to stay,
 * an unauthenticated request gets nothing, and a call that runs too long is stopped rather than waited on.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupJob, createLabHandler, executePodman, jobName, planCommand, stageJob } from "../../src/lab/daemon.mjs";

const LIMITS = { cpus: 2, memoryMb: 1024, pids: 128, jobTimeoutMs: 5_000, concurrency: 1 };

function fakeRun({ exit = 0, stdout = "", stderr = "", compose = true, hold = null } = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (hold) await hold;
    if (argv[0] === "compose" && !compose) return { exit: 127, stdout: "", stderr: "unknown command" };
    if (argv[0] === "ps") return { exit: 0, stdout: "laidback-job9-db\n", stderr: "" };
    return { exit, stdout, stderr };
  };
  return { run, calls };
}

function request({ url = "/run", headers = {}, body = {} }) {
  const req = {
    url,
    headers,
    on(event, handler) {
      if (event === "data") handler(Buffer.from(JSON.stringify(body)));
      if (event === "end") handler();
      return req;
    },
    destroy() {},
  };
  const res = {
    status: 0,
    payload: null,
    writeHead(status) {
      res.status = status;
    },
    end(text) {
      res.payload = JSON.parse(text);
    },
  };
  return { req, res };
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lab-${label}-`));
}

test("the quotas and the mount reach every action", () => {
  const run = planCommand({ action: "run", params: { image: "postgres:16-alpine", cmd: "psql -f /work/migration.sql" }, limits: LIMITS, egress: "registries", jobDir: "/lab/j1", jobId: "j1" });
  assert.deepEqual(run.argv.slice(0, 2), ["run", "--rm"]);
  assert.ok(run.argv.includes("--network") && run.argv[run.argv.indexOf("--network") + 1] === "laidback-lab");
  assert.deepEqual(run.argv.slice(run.argv.indexOf("--cpus"), run.argv.indexOf("--cpus") + 6), ["--cpus", "2", "--memory", "1024m", "--pids-limit", "128"]);
  assert.ok(run.argv.some((arg) => arg.startsWith("/lab/j1/work:/work:ro")), "the job's own files, read-only");

  const sealed = planCommand({ action: "run", params: { image: "alpine", cmd: "id" }, limits: LIMITS, egress: "none", jobDir: "/lab/j2", jobId: "j2" });
  assert.equal(sealed.argv[sealed.argv.indexOf("--network") + 1], "none");

  const detached = planCommand({ action: "start", params: { image: "redis:7-alpine", env: { ALLOW: "1", "bad-name": "x" } }, limits: LIMITS, jobDir: "/lab/j3", jobId: "j3" });
  assert.ok(detached.argv.includes("-d"));
  assert.ok(detached.argv.includes("-e"));
  assert.ok(!detached.argv.some((arg) => arg.startsWith("bad-name=")), "only well-formed env names pass");

  const built = planCommand({ action: "build", params: { dockerfile: ".build/Dockerfile", image: "codegen:review" }, limits: LIMITS, jobDir: "/lab/j4", jobId: "j4" });
  assert.deepEqual(built.argv, ["build", "--network", "laidback-lab", "-f", "/lab/j4/work/.build/Dockerfile", "-t", "codegen:review", "-"]);
  assert.equal(built.stdinTar, true, "the context arrives on stdin");

  assert.equal(planCommand({ action: "down", params: {}, limits: LIMITS, jobDir: "/lab/j5", jobId: "j5" }).cleanup, true);
  assert.throws(() => planCommand({ action: "run", params: { image: "alpine" }, limits: LIMITS, jobDir: "/x", jobId: "j" }), /run needs a command/);

  // The reference keeps what makes it a reference.
  const named = planCommand({ action: "run", params: { image: "docker.io/library/busybox:latest", cmd: "id" }, limits: LIMITS, jobDir: "/lab/j6", jobId: "j6" });
  assert.ok(named.argv.includes("docker.io/library/busybox:latest"), named.argv.join(" "));
  assert.throws(() => planCommand({ action: "run", params: { image: "alpine; rm -rf /", cmd: "id" }, limits: LIMITS, jobDir: "/lab/j7", jobId: "j7" }), /image reference is not allowed/);
});

test("a job name cannot drift onto someone else's container", () => {
  assert.equal(jobName("abc", "db"), "laidback-abc-db");
  assert.equal(jobName("../../etc/passwd"), "laidback-.._.._etc_passwd", "no path separators in a container name");
  assert.ok(!/[\s"']/.test(jobName('a b "c')), "no shell words either");
});

test("staged files stay inside the job, and oversize ones are refused", () => {
  const jobDir = tempDir("stage");
  const staged = stageJob({
    jobDir,
    files: [
      { path: "migration.sql", contents: "CREATE TABLE orders (id int);" },
      { path: "../../escape.txt", contents: "no" },
      { path: "big.txt", contents: "x".repeat(600_000) },
    ],
  });
  assert.equal(staged.written, "CREATE TABLE orders (id int);".length);
  assert.equal(fs.readFileSync(path.join(jobDir, "work", "migration.sql"), "utf8"), "CREATE TABLE orders (id int);");
  assert.equal(fs.existsSync(path.join(jobDir, "..", "escape.txt")), false);
  assert.deepEqual(staged.skipped.map((line) => line.split(":")[0]), ["../../escape.txt", "big.txt"]);
});

test("an unauthenticated request is refused before anything runs", async () => {
  const { run, calls } = fakeRun();
  const handler = createLabHandler({ limits: LIMITS, token: "let-me-in", run, workspace: tempDir("auth") });
  const { req, res } = request({ headers: { authorization: "Bearer wrong" }, body: { image: "alpine", cmd: "id" } });
  await handler(req, res);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, "nothing was started");
});

test("a foreground job is cleaned up, a started one is left running", async () => {
  const workspace = tempDir("clean");
  const { run, calls } = fakeRun({ stdout: "applied" });
  const cleaned = [];
  const handler = createLabHandler({ limits: LIMITS, token: "", run, workspace, cleanup: async ({ jobId }) => cleaned.push(jobId) });

  const one = request({ url: "/run", body: { job: "jobA", image: "alpine", cmd: "id" } });
  await handler(one.req, one.res);
  assert.equal(one.res.payload.exit, 0);
  assert.equal(one.res.payload.stdout, "applied");
  assert.deepEqual(cleaned, ["jobA"]);

  const two = request({ url: "/start", body: { job: "jobB", image: "postgres:16-alpine" } });
  await handler(two.req, two.res);
  assert.ok(calls.some((argv) => argv[0] === "run" && argv.includes("-d")));
  assert.deepEqual(cleaned, ["jobA"], "the service stays up for exec and logs");
});

test("compose without compose support says so instead of pretending", async () => {
  const { run } = fakeRun({ compose: false });
  const handler = createLabHandler({ limits: LIMITS, run, workspace: tempDir("compose") });
  const { req, res } = request({ url: "/compose", body: { job: "jobC", compose: "compose.yaml", cmd: "up -d" } });
  await handler(req, res);
  assert.equal(res.payload.exit, 127);
  assert.match(res.payload.stderr, /no compose support/);
});

test("one job at a time, even when two arrive together", async () => {
  const workspace = tempDir("queue");
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const { run, calls } = fakeRun({ hold });
  const handler = createLabHandler({ limits: { ...LIMITS, concurrency: 1 }, run, workspace });

  const first = request({ url: "/run", body: { job: "q1", image: "alpine", cmd: "id" } });
  const running = handler(first.req, first.res);
  const second = request({ url: "/run", body: { job: "q2", image: "alpine", cmd: "id" } });
  const waiting = handler(second.req, second.res);

  const started = () => calls.filter((argv) => argv[0] === "run").length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started(), 1, "the second job waits for the first");
  releaseHold();
  await Promise.all([running, waiting]);
  assert.equal(started(), 2);
});

test("a job that runs too long is killed and reported", async () => {
  const result = await executePodman({ binary: "/bin/sleep", argv: ["5"], cwd: "/tmp", timeoutMs: 250 });
  assert.equal(result.exit, 124);
  assert.match(result.stderr, /wall clock/);

  const echo = await executePodman({ binary: "/bin/echo", argv: ["hello from the lab"], cwd: "/tmp", timeoutMs: 5_000 });
  assert.equal(echo.exit, 0);
  assert.match(echo.stdout, /hello from the lab/);

  const missing = await executePodman({ binary: "definitely-not-a-runtime", argv: ["--help"], cwd: "/tmp", timeoutMs: 1_000 });
  assert.ok(missing.exit !== 0);
});

test("cleanup removes this job's containers and its directory", async () => {
  const jobDir = tempDir("job");
  fs.mkdirSync(path.join(jobDir, "work"), { recursive: true });
  const { run, calls } = fakeRun();
  await cleanupJob({ run, jobId: "job9", jobDir });
  assert.deepEqual(calls[0], ["ps", "-a", "--filter", "name=laidback-job9", "--format", "{{.Names}}"]);
  assert.ok(calls.some((argv) => argv[0] === "rm" && argv[1] === "-f" && argv[2] === "laidback-job9-db"));
  assert.equal(fs.existsSync(jobDir), false);
});
