/**
 * GitHub REST client.
 *
 * One place to hold the capability ceiling: the paths below are all the bot uses, and the only
 * mutating one is `postReview`. The credential behind the token is scoped to match
 * (Pull requests: read and write, Contents: read-only), so the ceiling is not only a convention.
 */

const USER_AGENT = "laidback-reviewer";

export class GithubError extends Error {
  constructor({ method, path, status, message }) {
    super(`${method} ${path} → ${status}: ${message}`);
    this.name = "GithubError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

export function createGithubClient({ baseUrl = "https://api.github.com", token, fetchImpl = fetch, log = () => {} }) {
  if (!token) throw new Error("GitHub token is empty: check github.tokenEnv in config.yaml");

  async function request(method, path, body) {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const remaining = response.headers.get("x-ratelimit-remaining");
    log(`${method} ${path} → ${response.status}${remaining !== null ? ` (rate remaining ${remaining})` : ""}`);

    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      if (retryAfter > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return request(method, path, body);
      }
    }

    if (!response.ok) {
      let message = response.statusText;
      try {
        const parsed = await response.json();
        message = parsed.message ?? message;
      } catch {
        // a non-JSON error body keeps statusText
      }
      throw new GithubError({ method, path, status: response.status, message });
    }
    return response.json();
  }

  const repoPath = (owner, repo) => `/repos/${owner}/${repo}`;

  return {
    request,
    getRepo: (owner, repo) => request("GET", repoPath(owner, repo)),
    getPull: (owner, repo, pr) => request("GET", `${repoPath(owner, repo)}/pulls/${pr}`),
    listFiles: async (owner, repo, pr, perPage = 100) => {
      const collected = [];
      for (let page = 1; ; page += 1) {
        const batch = await request("GET", `${repoPath(owner, repo)}/pulls/${pr}/files?per_page=${perPage}&page=${page}`);
        collected.push(...batch);
        if (batch.length < perPage) break;
      }
      return collected;
    },
    listReviews: (owner, repo, pr) => request("GET", `${repoPath(owner, repo)}/pulls/${pr}/reviews?per_page=100`),
    listInlineComments: (owner, repo, pr) => request("GET", `${repoPath(owner, repo)}/pulls/${pr}/comments?per_page=100`),
    /** Open and closed PRs whose head branch is `branch`; how a stack link is found. */
    listPullsForHead: (owner, repo, branch) =>
      request("GET", `${repoPath(owner, repo)}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`),
    listTimeline: (owner, repo, pr) => request("GET", `${repoPath(owner, repo)}/issues/${pr}/timeline?per_page=100`),
    /**
     * Search cannot OR qualifiers, so the org/repo allowlist is applied client-side by
     * matchesScope(). A wide search plus a narrow filter also keeps the query cacheable.
     */
    searchAssigned: ({ me, sinceIso }) => {
      const query = `is:pr is:open archived:false assignee:${me} updated:>=${sinceIso.slice(0, 10)}`;
      return request("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=updated&order=desc`);
    },
    postReview: (owner, repo, pr, payload) => request("POST", `${repoPath(owner, repo)}/pulls/${pr}/reviews`, payload),
    /**
     * Exists only for the startup scope probe in github/token-probe.mjs, which sends a base sha no
     * repository contains. Nothing else in this codebase calls it, and the point of calling it is to
     * be refused.
     */
    putContents: (owner, repo, path, payload) => request("PUT", `${repoPath(owner, repo)}/contents/${path}`, payload),
  };
}

/** Allowlist filter for search results: `repository_url` carries owner/name. */
export function matchesScope(item, { orgs = [], repos = [] }) {
  const url = item?.repository_url ?? "";
  const fullName = url.replace(/^.*\/repos\//, "");
  if (!fullName) return false;
  if (repos.length && repos.includes(fullName)) return true;
  if (!orgs.length) return repos.length === 0;
  return orgs.includes(fullName.split("/")[0]);
}
