/**
 * GitHub REST client.
 *
 * The capability ceiling lives here: the paths below are all the bot uses, and writes are refused
 * before any request leaves the process unless the route is a pull-request review. The credential is
 * scoped to match (Pull requests: read and write, Contents: read-only).
 */

const USER_AGENT = "laidback-reviewer";

// A misconfigured token cannot turn this client into a contents writer, which is also why there is no
// startup probe: a probe would have to attempt a write to find out.
const WRITE_ROUTES = [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/];

export function assertWriteAllowed(method, path) {
  if (method === "GET" || method === "HEAD") return;
  const pathname = String(path).split("?")[0];
  if (WRITE_ROUTES.some((route) => route.test(pathname))) return;
  throw new GithubError({ method, path, status: 0, message: "refused: this client writes only to a pull-request review endpoint" });
}

export class GithubError extends Error {
  constructor({ method, path, status, message }) {
    super(`${method} ${path} → ${status}: ${message}`);
    this.name = "GithubError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

export function createGithubClient({ baseUrl = "https://api.github.com", token, fetchImpl = fetch, timeoutMs = 30_000, log = () => {} }) {
  if (!token) throw new Error("GitHub token is empty: check github.tokenEnv in config.yaml");

  async function request(method, path, body) {
    assertWriteAllowed(method, path);
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A hung request here stops a cycle without saying so, so the path belongs in the message.
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new Error(`github api answered nothing within ${timeoutMs}ms: ${method} ${path}`);
      throw error;
    }

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

  const searchIssues = (qualifier, sinceIso) => {
    const query = `is:pr is:open archived:false ${qualifier} updated:>=${sinceIso.slice(0, 10)}`;
    return request("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=updated&order=desc`);
  };

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
    // One query per trigger mode. A team request would be `review-requested:@org/team`, never used.
    searchAssigned: ({ me, sinceIso }) => searchIssues(`assignee:${me}`, sinceIso),
    searchReviewRequested: ({ me, sinceIso }) => searchIssues(`review-requested:${me}`, sinceIso),
    postReview: (owner, repo, pr, payload) => request("POST", `${repoPath(owner, repo)}/pulls/${pr}/reviews`, payload),
  };
}

/** Full name ("owner/name") as a search hit reports it. */
export function repositoryFullName(item) {
  return String(item?.repository_url ?? "").replace(/^.*\/repos\//, "");
}
