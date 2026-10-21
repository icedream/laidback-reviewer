/**
 * Read-only checkouts.
 *
 * A review runs in a detached worktree under the scratch root, so a build leaves nothing behind in the
 * cached clone. The token reaches git through a helper that reads the environment variable when git
 * asks: it is never written into a remote URL, .git/config, or a process argument list.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function credentialHelper(tokenEnv) {
  return `-c credential.helper=!f(){ echo username=x-access-token; echo password=$${tokenEnv}; };f`;
}

function git(args, { cwd, tokenEnv } = {}) {
  const prefixed = tokenEnv ? [credentialHelper(tokenEnv), ...args] : args;
  return execFileSync("git", prefixed, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function repoDir(cfg, owner, repo) {
  return path.resolve(cfg.checkout.root, owner, repo);
}

export function worktreeDir(cfg, owner, repo, pr, headSha) {
  return path.resolve(cfg.checkout.scratch, `${owner}-${repo}-${pr}-${headSha.slice(0, 8)}`);
}

/**
 * Prepare the tree a review runs in. Returns { dir, headSha, cachedClone }.
 *
 * `existing` points at a tree someone else prepared: the integration test, or a checkout you keep
 * warm by hand. `clone` maintains a cached clone and adds one detached worktree per review.
 */
export function prepareCheckout({ cfg, owner, repo, pr, headRef, headSha, log = () => {} }) {
  if (cfg.checkout.mode === "existing") {
    const dir = path.resolve(cfg.checkout.existingDir || repoDir(cfg, owner, repo));
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`checkout.mode=existing but ${dir} is not a git repository`);
    return { dir, headSha: git(["rev-parse", "HEAD"], { cwd: dir }), cachedClone: null };
  }

  const tokenEnv = cfg.github.tokenEnv;
  const cached = repoDir(cfg, owner, repo);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.mkdirSync(path.resolve(cfg.checkout.scratch), { recursive: true });

  if (!fs.existsSync(path.join(cached, ".git"))) {
    log(`clone ${owner}/${repo} → ${cached}`);
    git(["clone", "--filter=blob:none", `https://github.com/${owner}/${repo}.git`, cached], { tokenEnv });
  } else {
    git(["fetch", "--prune", "origin", headRef], { cwd: cached, tokenEnv });
  }

  const dir = worktreeDir(cfg, owner, repo, pr, headSha);
  if (fs.existsSync(dir)) {
    log(`reusing worktree ${dir}`);
    return { dir, headSha, cachedClone: cached };
  }
  git(["worktree", "add", "--detach", dir, headSha], { cwd: cached });
  return { dir, headSha, cachedClone: cached };
}

export function releaseWorktree({ cfg, dir, cachedClone, log = () => {} }) {
  if (cfg.checkout.mode === "existing" || !cachedClone) return;
  try {
    git(["worktree", "remove", "--force", dir], { cwd: cachedClone });
  } catch (error) {
    log(`worktree remove failed for ${dir}: ${error.message}`);
  }
}

/**
 * Ref comparison. A review often needs a side of the diff that is not in the PR tree: trunk as it is
 * now, a release tag, or the repository of a dependency whose version changed. Those go in the
 * comparison root, fetched with the same contents-read-only credential.
 */
export function prepareComparisonDir({ cfg, log = () => {} }) {
  const dir = path.resolve(cfg.checkout.compareDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Make authenticated read-only git work for checkouts the run starts itself, including clones in the
 * comparison root: `go mod download` and bare `git clone` shell out to git without our -c flags, so
 * the helper has to be recorded in a config file. What is recorded reads the environment variable.
 */
export function configureGitAuth({ cfg, dir, log = () => {} }) {
  const helper = credentialHelper(cfg.github.tokenEnv).replace(/^-c /, "");
  git(["config", "--local", "credential.helper", helper], { cwd: dir });
  git(["config", "--local", "url.https://github.com/.insteadOf", "git@github.com:"], { cwd: dir });
  process.env.GIT_CONFIG_GLOBAL = path.resolve(cfg.checkout.gitConfig || ".pi/gitconfig");
  fs.mkdirSync(path.dirname(process.env.GIT_CONFIG_GLOBAL), { recursive: true });
  if (!fs.existsSync(process.env.GIT_CONFIG_GLOBAL)) {
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL,
      `[credential]\n\thelper = ${helper}\n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n`,
    );
  }
  log(`git auth: credential helper reads $${cfg.github.tokenEnv}, global config ${process.env.GIT_CONFIG_GLOBAL}`);
}

/** GOPRIVATE so `go test` can fetch private module dependencies without a checksum proxy. */
export function configureGoModules({ cfg, dir, log = () => {} }) {
  if (!cfg.checkout.goPrivate.length) return;
  process.env.GOPRIVATE = cfg.checkout.goPrivate.join(",");
  log(`GOPRIVATE=${process.env.GOPRIVATE}`);
}
