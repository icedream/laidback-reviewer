/**
 * The lab client: the harness' door to a container, and the record it leaves.
 *
 * Nothing here reaches GitHub. What matters is that a call either returns an outcome the review can be
 * held to, or says plainly that the check did not run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLabClient, labEnabled, labGateRow } from "../../src/lab/client.mjs";
import { baseConfig } from "../helpers/run-env.mjs";

function cfgWith(extra = {}) {
  const cfg = baseConfig({ dir: "/work" });
  cfg.lab = { ...cfg.lab, enabled: true, url: "http://lab.local:9443", ...extra };
  return cfg;
}

function recordingFetch(reply = () => ({ status: 200, body: { exit: 0, stdout: "applied 3 migrations" } })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const { status, body } = reply();
      return { ok: status < 400, status, json: async () => body };
    },
  };
}

test("the lab is off unless it is both enabled and addressed", () => {
  const cfg = baseConfig({ dir: "/work" });
  assert.equal(labEnabled(cfg), false, "default config");
  assert.equal(createLabClient({ cfg }), null);

  const addressed = { ...cfg, lab: { ...cfg.lab, enabled: true, url: "http://lab:1" } };
  assert.equal(labEnabled(addressed), true);
  assert.notEqual(createLabClient({ cfg: addressed }), null);

  // Enabled with no URL is a config mistake, not an invitation to dial an empty string.
  assert.equal(labEnabled({ ...cfg, lab: { ...cfg.lab, enabled: true, url: "" } }), false);
});

test("a lab call carries the ceiling and the token, and reports the job", async () => {
  const transport = recordingFetch();
  const lab = createLabClient({ cfg: cfgWith({ egress: "registries", cpus: 2 }), env: { LAIDBACK_LAB_TOKEN: "lab-secret" }, fetchImpl: transport.fetchImpl });

  const result = await lab.call("run", { image: "postgres:16-alpine", cmd: "psql -f migration.sql" });

  assert.equal(transport.calls[0].url, "http://lab.local:9443/run");
  assert.equal(transport.calls[0].init.headers.authorization, "Bearer lab-secret");
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sent.limits, { cpus: 2, memoryMb: 4096, diskMb: 20480, pids: 512, timeoutMs: 600_000 });
  assert.equal(sent.egress, "registries");
  assert.equal(result.ok, true);
  assert.equal(result.exit, 0);
  assert.match(result.stdout, /applied 3 migrations/);
});

test("an unreachable or refusing daemon is not_run, never a silent pass", async () => {
  const cfg = cfgWith();
  const log = [];

  const down = createLabClient({ cfg, env: {}, fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); }, log: (line) => log.push(line) });
  const unreachable = await down.call("build", { dockerfile: ".ci/scripts/builder.Dockerfile" });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.error, /lab daemon unreachable/);

  const refused = createLabClient({ cfg, env: {}, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "image not permitted" }) }), log: (line) => log.push(line) });
  const outcome = await refused.call("run", { image: "kali/tools" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /image not permitted/);
  assert.match(log.join("\n"), /lab run refused/);

  assert.equal(labGateRow("run", { image: "kali/tools" }, outcome).result, "not_run");
});

test("an unknown action is refused before anything is sent", async () => {
  const transport = recordingFetch();
  const lab = createLabClient({ cfg: cfgWith(), env: {}, fetchImpl: transport.fetchImpl });
  const result = await lab.call("exec_something", { cmd: "id" });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown lab action/);
  assert.equal(transport.calls.length, 0);
});

test("the gate row says what ran, what it cost, and what came out", () => {
  const row = labGateRow(
    "build",
    { dockerfile: ".ci/scripts/builder.Dockerfile", label: "does the pin build" },
    { ok: true, exit: 1, stdout: "unable to find image golang:1.26.6", stderr: "", image: "builder:review", jobId: "j-12", durationMs: 91_000, egress: "registries" },
  );
  assert.equal(row.gate, "lab build: .ci/scripts/builder.Dockerfile (does the pin build)");
  assert.equal(row.result, "fail");
  assert.match(row.evidence, /job j-12 at 91000ms, exit 1, egress registries, image builder:review/);
  assert.match(row.evidence, /unable to find image/);

  const passed = labGateRow("run", { image: "postgres:16-alpine" }, { ok: true, exit: 0, stdout: "CREATE TABLE", image: "postgres:16-alpine", jobId: "j-13", durationMs: 4000, egress: "none" });
  assert.equal(passed.result, "pass");
});

test("what the call names is shipped by the harness, and what it does not own stops the call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-stage-"));
  fs.writeFileSync(path.join(dir, "migration.sql"), "CREATE TABLE orders (id int);");
  const transport = recordingFetch();
  const lab = createLabClient({ cfg: cfgWith(), env: {}, staging: { roots: [dir] }, fetchImpl: transport.fetchImpl });

  const good = await lab.call("run", { image: "postgres:16-alpine", cmd: "psql -f /work/migration.sql", files: [path.join(dir, "migration.sql")] });
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sent.files, [{ path: "migration.sql", contents: "CREATE TABLE orders (id int);" }]);
  assert.equal(good.ok, true);

  // A check that runs with half its files would answer a different question than the review asked for.
  const greedy = await lab.call("run", { image: "postgres:16-alpine", cmd: "id", files: [path.join(dir, "migration.sql"), "/etc/passwd"] });
  assert.equal(greedy.ok, false);
  assert.match(greedy.error, /not inside this run's scratch/);
  assert.equal(transport.calls.length, 1, "the request was never sent");
});

test("a build context travels as a capped tarball", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-ctx-"));
  fs.mkdirSync(path.join(dir, "ctx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ctx", "Dockerfile"), "FROM golang:1.26\nRUN go version\n");
  fs.mkdirSync(path.join(dir, "ctx", ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ctx", ".git", "HEAD"), "ref: refs/heads/main");

  const transport = recordingFetch();
  const lab = createLabClient({ cfg: cfgWith(), env: {}, staging: { roots: [dir] }, fetchImpl: transport.fetchImpl });
  await lab.call("build", { dockerfile: "Dockerfile", context: path.join(dir, "ctx") });

  const sent = JSON.parse(transport.calls[0].init.body);
  assert.ok(sent.contextTar?.length > 20, "a tarball, not a path the daemon cannot read");
  const packed = Buffer.from(sent.contextTar, "base64");
  assert.equal(packed[0], 0x1f, "gzip magic");
  assert.ok(!packed.subarray(0, Math.min(packed.length, 4000)).includes(Buffer.from(".git/HEAD")), "the repository's git dir is not shipped");

  const outside = await lab.call("build", { dockerfile: "Dockerfile", context: "/etc" });
  assert.match(outside.error, /not inside this run's scratch/);
});

test("a staged file may be named relative to the scratch root", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-relative-"));
  fs.mkdirSync(path.join(dir, "lab333"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lab333", "migcheck.sh"), "psql -f /work/lab333/migcheck.sql\n");
  const transport = recordingFetch();
  const lab = createLabClient({ cfg: cfgWith(), env: {}, staging: { roots: [dir] }, fetchImpl: transport.fetchImpl });

  // The review stands in its checkout and names files as it sees them. Every form must reach the same
  // path inside the container instead of bouncing as "not inside this run's scratch".
  for (const name of ["lab333/migcheck.sh", "scratch/lab333/migcheck.sh", "./lab333/migcheck.sh", path.join(dir, "lab333", "migcheck.sh")]) {
    await lab.call("run", { image: "postgres:16-alpine", cmd: "sh /work/lab333/migcheck.sh", files: [name] });
    const sent = JSON.parse(transport.calls.at(-1).init.body);
    assert.deepEqual(sent.files, [{ path: "lab333/migcheck.sh", contents: "psql -f /work/lab333/migcheck.sql\n" }], `naming it ${name} stages the same file`);
  }

  const outside = await lab.call("run", { image: "alpine", cmd: "id", files: ["../../etc/passwd"] });
  assert.match(outside.error, /give it relative to/);
  assert.equal(transport.calls.length, 4, "a path outside the scratch never reaches the lab");
  fs.rmSync(dir, { recursive: true, force: true });
});
