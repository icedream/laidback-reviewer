/**
 * Read-only checkouts.
 *
 * A review runs in a detached worktree under the scratch root, so a build leaves nothing behind in the
 * cached clone. The token reaches git through a helper that reads the environment variable when git
 * asks: it is never written into a remote URL, .git/config, or a process argument list.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Two argv entries: git reads `-c` and its value separately, and the value names the environment
// variable rather than holding the token.
export function credentialHelperArgs(tokenEnv) {
  return ["-c", `credential.helper=!f(){ echo username=x-access-token; echo password=$${tokenEnv}; };f`];
}

const credentialHelperValue = (tokenEnv) => credentialHelperArgs(tokenEnv)[1].replace(/^credential\.helper=/, "");

/**
 * Options for a git call. A stalled transfer or a credential prompt is what leaves a review sitting
 * there with the model idle, so git is told to fail rather than ask, and every call has a deadline.
 */
export function gitExecOptions(cfg, { long = false } = {}) {
  return {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: long ? cfg.checkout.transferTimeoutMs : cfg.checkout.commandTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_HTTP_LOW_SPEED_LIMIT: "10240", GIT_HTTP_LOW_SPEED_TIME: "30" },
  };
}

function git(args, { cwd, tokenEnv, cfg, long = false } = {}) {
  const prefixed = tokenEnv ? [...credentialHelperArgs(tokenEnv), ...args] : args;
  const options = gitExecOptions(cfg ?? { checkout: { commandTimeoutMs: 60_000, transferTimeoutMs: 300_000 } }, { long });
  try {
    return execFileSync("git", prefixed, { cwd, ...options }).trim();
  } catch (error) {
    if (error?.killed || error?.signal) throw new Error(`git ${args.join(" ")} was cancelled after ${options.timeout}ms`);
    throw error;
  }
}

export function repoDir(cfg, owner, repo) {
  return path.resolve(cfg.checkout.root, owner, repo);
}

/** Identifies one review run, so its scratch area cannot be confused with another run's. */
export const newRunId = () => randomUUID().slice(0, 8);

const runLabel = (owner, repo, pr, headSha, runId) => `${owner}-${repo}-${pr}-${headSha.slice(0, 8)}${runId ? `-${runId}` : ""}`;

export function worktreeDir(cfg, owner, repo, pr, headSha, runId = "") {
  return path.resolve(cfg.checkout.scratch, runLabel(owner, repo, pr, headSha, runId));
}

/**
 * Where a run keeps the versions it fetched for comparison: trunk as it is now, a dependency's other
 * tags. Per run, because a session carries on with the paths it saw, and another run's files in the
 * same place would be read as if they belonged to this one.
 */
export function comparisonDir(cfg, owner, repo, pr, headSha, runId = "") {
  return path.join(path.resolve(cfg.checkout.compareDir), runLabel(owner, repo, pr, headSha, runId));
}

/**
 * Prepare the tree a review runs in. Returns { dir, headSha, cachedClone }.
 *
 * `existing` points at a tree someone else prepared: the integration test, or a checkout you keep
 * warm by hand. `clone` maintains a cached clone and adds one detached worktree per review.
 */
export function prepareCheckout({ cfg, owner, repo, pr, headRef, headSha, runId = newRunId(), log = () => {} }) {
  const compare = comparisonDir(cfg, owner, repo, pr, headSha, runId);
  fs.mkdirSync(compare, { recursive: true });

  if (cfg.checkout.mode === "existing") {
    const dir = path.resolve(cfg.checkout.existingDir || repoDir(cfg, owner, repo));
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`checkout.mode=existing but ${dir} is not a git repository`);
    return { dir, headSha: git(["rev-parse", "HEAD"], { cwd: dir, cfg }), cachedClone: null, runId, compareDir: compare };
  }

  const tokenEnv = cfg.github.tokenEnv;
  const cached = repoDir(cfg, owner, repo);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.mkdirSync(path.resolve(cfg.checkout.scratch), { recursive: true });

  if (!fs.existsSync(path.join(cached, ".git"))) {
    log(`clone ${owner}/${repo} → ${cached}`);
    git(["clone", "--filter=blob:none", `https://github.com/${owner}/${repo}.git`, cached], { tokenEnv, cfg, long: true });
  } else {
    git(["fetch", "--prune", "origin", headRef], { cwd: cached, tokenEnv, cfg, long: true });
  }
  // Now that the clone exists, the repository-local settings apply to anything run from inside it.
  applyLocalGitAuth({ cfg, dir: cached });

  const dir = worktreeDir(cfg, owner, repo, pr, headSha, runId);
  if (fs.existsSync(dir)) {
    log(`reusing worktree ${dir}`);
    return { dir, headSha, cachedClone: cached, runId, compareDir: compare };
  }
  git(["worktree", "add", "--detach", dir, headSha], { cwd: cached, cfg });
  return { dir, headSha, cachedClone: cached, runId, compareDir: compare };
}

export function releaseWorktree({ cfg, dir, cachedClone, compareDir, log = () => {} }) {
  if (cachedClone) {
    try {
      git(["worktree", "remove", "--force", dir], { cwd: cachedClone, cfg });
    } catch (error) {
      log(`worktree remove failed for ${dir}: ${error.message}`);
    }
  }
  // Fetched comparisons are the biggest thing a run leaves behind, and nothing after this run may read
  // it as if it were its own.
  if (compareDir) fs.rmSync(compareDir, { recursive: true, force: true });
}

/**
 * Make authenticated read-only git work for checkouts the run starts itself, including clones in the
 * comparison root: `go mod download` and bare `git clone` shell out to git without our -c flags, so
 * the helper has to be recorded in a config file. What is recorded reads the environment variable.
 */
export function configureGitAuth({ cfg, dir, log = () => {} }) {
  const helper = credentialHelperValue(cfg.github.tokenEnv);
  // The global file is what covers commands the run does not spawn itself: `go mod download`, a bare
  // `git clone`, or a tool the repository's own Makefile calls.
  process.env.GIT_CONFIG_GLOBAL = path.resolve(cfg.checkout.gitConfig || ".pi/gitconfig");
  fs.mkdirSync(path.dirname(process.env.GIT_CONFIG_GLOBAL), { recursive: true });
  const desired = `[credential]\n\thelper = ${helper}\n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n`;
  // Rewrite whenever the file disagrees with this run's token variable. A file left over from an older
  // version of the harness would otherwise keep a malformed helper, and git then tries to exec
  // `git credential-credential.helper=...` for every shell-out that needs credentials.
  const current = fs.existsSync(process.env.GIT_CONFIG_GLOBAL) ? fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, "utf8") : null;
  if (current !== desired) {
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, desired);
    if (current !== null) log(`git auth: rewrote ${process.env.GIT_CONFIG_GLOBAL}, its credential helper did not match this run`);
  }
  // A clone-mode run configures auth before cloning, so the checkout directory may not be a repository
  // yet; setting local config there fails, and the global file already carries the same settings.
  applyLocalGitAuth({ cfg, dir });
  log(`git auth: credential helper reads $${cfg.github.tokenEnv}, global config ${process.env.GIT_CONFIG_GLOBAL}`);
}

function applyLocalGitAuth({ cfg, dir }) {
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return false;
  const helper = credentialHelperValue(cfg.github.tokenEnv);
  git(["config", "--local", "credential.helper", helper], { cwd: dir, cfg });
  git(["config", "--local", "url.https://github.com/.insteadOf", "git@github.com:"], { cwd: dir, cfg });
  return true;
}

/**
 * The Go environment the agent's gates run in. GOPRIVATE keeps private modules off the public checksum
 * proxy, and goProxy points a build at a mirror such as an Athens instance.
 */
export function configureGoModules({ cfg, log = () => {} }) {
  const set = (name, value) => {
    if (!value) return;
    process.env[name] = value;
    log(`${name}=${value}`);
  };
  set("GOPRIVATE", cfg.checkout.goPrivate.join(","));
  set("GOPROXY", cfg.checkout.goProxy);
  set("GOSUMDB", cfg.checkout.goSumDb);
  set("GOFLAGS", cfg.checkout.goFlags);
}
