/**
 * Which golangci-lint a repository expects.
 *
 * Images pin one release, repositories pin another, and a v1 binary cannot read a v2 config. The pins
 * are read from the repository and the pinned release is installed into a writable cache, so a
 * missing linter stays a tooling fact rather than becoming a review finding.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const TAG = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const WORKFLOW_SOURCES = [
  // golangci-lint-action with an explicit version input.
  { name: "golangci-lint-action", pattern: /uses:\s*[^\s]*golangci-lint-action[^\n]*\n(?:[^\n]*\n)*?\s*version:\s*(v\d[\w.\-]*)/g },
  { name: "GOLANGCI_LINT_VERSION (workflow env)", pattern: /GOLANGCI_LINT_VERSION:\s*["']?(v?\d[\w.\-]*)/g },
  // A reusable workflow takes the version as an input, under a name the repository chose.
  { name: "reusable workflow input", pattern: /^\s*["']?(?:golangci[-_]?lint[-_]?version|lint[-_]?version|golangciLintVersion|lintVersion)["']?:\s*["']?(v?\d+\.\d+(?:\.\d+)?)/gm },
];
const REUSABLE_CALL = /uses:\s*([^\s]+\/\.github\/workflows\/[\w.\-]+\.ya?ml)@(\S+)/g;
const OTHER_SOURCES = [
  { file: "Makefile", pattern: /GOLANGCI_LINT_VERSION\s*\??=\s*(v?\d[\w.\-]*)/g },
  { file: ".tool-versions", pattern: /^golangci-lint\s+(v?\d[\w.\-]*)/gm },
  { file: ".mise.toml", pattern: /golangci-lint\s*=\s*["']?(v?\d[\w.\-]*)/g },
];

function readIf(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The config file's own schema major, which decides which binaries can load it. */
export function detectConfigSchemaMajor(dir) {
  for (const name of [".golangci.yml", ".golangci.yaml", ".golangci.toml"]) {
    const text = readIf(path.join(dir, name));
    const match = text.match(/^\s*version:\s*"?(\d+)"?/m);
    if (match) return { major: match[1], source: name };
  }
  return null;
}

/**
 * Every version the repository pins, in the order they were found.
 * CI pins win over a Makefile, because the review's gate should mirror what CI runs.
 */
export function detectLintPins(dir) {
  const pins = [];
  const reusable = [];
  const workflowDir = path.join(dir, ".github", "workflows");
  let workflowFiles = [];
  try {
    workflowFiles = fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));
  } catch {
    workflowFiles = [];
  }

  for (const name of workflowFiles) {
    const text = readIf(path.join(workflowDir, name));
    for (const { name: label, pattern } of WORKFLOW_SOURCES) {
      for (const match of text.matchAll(pattern)) {
        const version = match[1].startsWith("v") ? match[1] : `v${match[1]}`;
        pins.push({ version, source: `.github/workflows/${name}: ${label}` });
      }
    }
    for (const match of text.matchAll(REUSABLE_CALL)) {
      reusable.push({ workflow: match[1], ref: match[2], source: `.github/workflows/${name}` });
    }
  }
  // One shared workflow is called by several jobs, and the owner's casing varies between them.
  reusable.splice(0, reusable.length, ...new Map(reusable.map((entry) => [`${entry.workflow}@${entry.ref}`.toLowerCase(), entry])).values());

  for (const { file, pattern } of OTHER_SOURCES) {
    const text = readIf(path.join(dir, file));
    for (const match of text.matchAll(pattern)) {
      const version = match[1].startsWith("v") ? match[1] : `v${match[1]}`;
      pins.push({ version, source: file });
    }
  }

  const configSchema = detectConfigSchemaMajor(dir);
  const chosen = pins[0] ?? null;
  const versions = [...new Set(pins.map((pin) => pin.version))];

  // A v1 pin against a v2 config is the common trap: the linter refuses to load the file and the
  // gate looks like a code problem when it is a tooling problem.
  const incompatible = configSchema ? versions.filter((version) => majorOf(version) !== configSchema.major) : [];

  return { pins, chosen, configSchema, reusable, conflict: versions.length > 1 || incompatible.length > 0, incompatible };
}

const majorOf = (version) => String(version).replace(/^v/, "").split(".")[0];

function reusableNote(reusable) {
  if (!reusable.length) return "no repository pin found, so the image's golangci-lint is used";
  const calls = reusable.map((entry) => `${entry.workflow}@${entry.ref}`).join(", ");
  return `no version input in this repository's workflows; they call ${calls}, where the default may live`;
}

/**
 * What the harness should provide.
 * `off` leaves the image's version alone, `image` means nothing extra is needed, `install` means the
 * pinned release is fetched into toolchain.installDir.
 */
export function planLint({ cfg, dir }) {
  const setting = cfg.toolchain.golangciLint;
  if (setting === "off") return { mode: "off", version: null, source: "toolchain.golangciLint=off" };
  if (setting !== "auto" && TAG.test(setting)) {
    const version = setting.startsWith("v") ? setting : `v${setting}`;
    return { mode: "install", version, source: "toolchain.golangciLint" };
  }

  const detected = detectLintPins(dir);
  if (!detected.chosen) return { mode: "image", version: null, source: "no pin found", detected };
  if (!cfg.toolchain.preferRepoVersion) return { mode: "image", version: null, source: "toolchain.preferRepoVersion=false", detected };
  return { mode: "install", version: detected.chosen.version, source: detected.chosen.source, detected };
}

export function releaseUrl({ downloadBaseUrl, version, platform = process.platform, arch = process.arch }) {
  const assetArch = arch === "arm64" ? "arm64" : "amd64";
  const assetPlatform = platform === "darwin" ? "darwin" : "linux";
  const bare = version.replace(/^v/, "");
  const asset = `golangci-lint-${bare}-${assetPlatform}-${assetArch}.tar.gz`;
  return `${downloadBaseUrl.replace(/\/$/, "")}/golangci/golangci-lint/releases/download/${version}/${asset}`;
}

const defaultExec = (timeoutMs = 120_000) => async (command, args) => {
  await run(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
};

/**
 * Fetch with the host check applied to every hop. GitHub release downloads redirect to an asset CDN,
 * and an allowlist that only looked at the first URL would be decorative.
 */
async function download({ url, to, allowHosts, fetchImpl = fetch, maxHops = 5, timeoutMs = 120_000 }) {
  let target = url;
  const seen = new Set();

  for (let hop = 0; hop < maxHops; hop += 1) {
    const host = new URL(target).hostname;
    if (!allowHosts.includes(host)) throw new Error(`refusing to fetch from ${host}: not in tools.allowHosts`);

    const response = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect without a location while fetching ${target}`);
      target = new URL(location, target).toString();
      if (seen.has(target)) throw new Error(`redirect loop while fetching ${url}`);
      seen.add(target);
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText || ""} for ${target}`.trim());

    fs.writeFileSync(to, Buffer.from(await response.arrayBuffer()));
    return target;
  }

  throw new Error(`too many redirects while fetching ${url}`);
}

/**
 * Make the pinned release available without touching the image or the repository.
 * The download is the harness's own action, so the same host allowlist the agent is held to applies.
 */
export async function ensureGolangciLint({
  cfg,
  version,
  downloadBaseUrl = cfg.toolchain.downloadBaseUrl || "https://github.com",
  execImpl = defaultExec(cfg.toolchain.execTimeoutMs),
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const target = path.join(cfg.toolchain.installDir, "golangci-lint", version);
  const bin = path.join(target, "bin", "golangci-lint");
  if (fs.existsSync(bin)) return { path: bin, version, cached: true };

  new URL(downloadBaseUrl); // fail early on a malformed base; hosts are checked per hop
  const url = releaseUrl({ downloadBaseUrl, version });
  fs.mkdirSync(target, { recursive: true });
  const archive = path.join(target, path.basename(url));
  log(`install golangci-lint ${version} → ${target}`);

  try {
    await download({ url, to: archive, allowHosts: cfg.tools.allowHosts, fetchImpl, timeoutMs: cfg.toolchain.downloadTimeoutMs });
    await execImpl("tar", ["-x", "-z", "--strip-components=1", "-C", target, "-f", archive]);
  } catch (error) {
    // The URL belongs in the message: a missing tag and a blocked egress look the same otherwise.
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`could not fetch ${url}: ${error.message}`);
  }
  fs.rmSync(archive, { force: true });

  if (!fs.existsSync(bin)) {
    // Some release layouts nest differently; find the binary rather than assume one path.
    const found = findBinary(target);
    if (!found) throw new Error(`golangci-lint ${version} extracted under ${target} but no bin/golangci-lint was found`);
    return { path: found, version, cached: false };
  }
  fs.chmodSync(bin, 0o755);
  return { path: bin, version, cached: false };
}

function findBinary(root) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === "golangci-lint") {
        fs.chmodSync(full, 0o755);
        return full;
      }
    }
  }
  return null;
}

/**
 * Everything the prompt needs to say about linting: what the repository pins, what the image has,
 * and what the harness installed.
 */
export async function resolveLintTool({ cfg, dir, execImpl, log = () => {} }) {
  const plan = planLint({ cfg, dir });
  const summary = {
    mode: plan.mode,
    requestedVersion: plan.version,
    source: plan.source,
    configSchema: plan.detected?.configSchema ?? null,
    pins: plan.detected?.pins ?? [],
    conflict: Boolean(plan.detected?.conflict),
    reusable: plan.detected?.reusable ?? [],
    installedPath: null,
    note: "",
  };

  if (plan.mode !== "install") {
    if (plan.mode === "image") summary.note = reusableNote(summary.reusable);
    return summary;
  }

  try {
    const installed = await ensureGolangciLint({ cfg, version: plan.version, execImpl, log });
    summary.installedPath = installed.path;
    summary.cached = installed.cached;
  } catch (error) {
    // A tool that cannot be fetched is a tooling gap, not a reason to skip the review.
    summary.note = `could not install ${plan.version}: ${error.message}`;
    log(`lint install failed: ${error.message}`);
  }
  return summary;
}
