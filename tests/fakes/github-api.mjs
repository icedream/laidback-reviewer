/**
 * Fake GitHub API for tests.
 *
 * Serves only the paths the bot is expected to touch and records every call, so a request outside
 * that set (a write to contents, a merge, an unexpected host path) fails the test rather than
 * silently succeeding. POST /pulls/N/reviews is the single write it accepts.
 */

import http from "node:http";

const OK = { "Content-Type": "application/json" };

export function createFakeGithubApi({ fixture, me = "octocat", token = "test-token", writeStatus = 201 }) {
  const calls = [];
  const postedReviews = [];
  const apiBase = `/repos/${fixture.owner}/${fixture.repo}`;

  const pr = {
    number: fixture.pr,
    title: fixture.title ?? "refactor: move order listing behind a service client",
    body: fixture.prBody ?? "",
    state: "open",
    draft: false,
    html_url: `https://github.com/${fixture.owner}/${fixture.repo}/pull/${fixture.pr}`,
    created_at: "2026-04-01T09:00:00Z",
    updated_at: "2026-04-03T11:20:00Z",
    user: { login: "dev-author", type: "User" },
    assignees: fixture.assignees ?? [{ login: me }],
    // Requested teams are recorded apart from reviewers, and must never qualify.
    requested_reviewers: fixture.requestedReviewers ?? [{ login: me, type: "User" }],
    requested_teams: fixture.requestedTeams ?? [],
    base: { ref: fixture.base.ref, sha: fixture.base.sha, repo: { full_name: `${fixture.owner}/${fixture.repo}` } },
    head: { ref: fixture.head.ref, sha: fixture.head.sha, repo: { full_name: `${fixture.owner}/${fixture.repo}` } },
    mergeable_state: "blocked",
    review_comments: 0,
    additions: fixture.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: fixture.files.reduce((sum, f) => sum + f.deletions, 0),
    changed_files: fixture.files.length,
  };

  const timeline = [
    {
      event: "review_requested",
      actor: { login: "tech-lead", type: "User" },
      requested_reviewer: { login: me, type: "User" },
      created_at: "2026-04-03T11:24:00Z",
    },
    {
      event: "assigned",
      actor: { login: "tech-lead", type: "User" },
      assignee: { login: me },
      created_at: "2026-04-03T11:25:00Z",
    },
  ];

  const routes = [
    {
      match: (method, p) => method === "GET" && p === apiBase,
      handle: () => ({
        full_name: `${fixture.owner}/${fixture.repo}`,
        default_branch: fixture.base.ref,
        private: true,
        permissions: { admin: false, push: false, pull: true },
      }),
    },
    {
      match: (method, p) => method === "GET" && p === `${apiBase}/pulls/${fixture.pr}`,
      handle: () => pr,
    },
    {
      match: (method, p) => method === "GET" && p === "/search/issues",
      handle: (query = {}) => {
        // One endpoint, two qualifiers: answer only when the fixture carries that relationship.
        const q = query.q ?? "";
        const mine = (list) => (list ?? []).some((entry) => String(entry.login ?? "").toLowerCase() === me.toLowerCase());
        const matched = q.includes("review-requested:") ? mine(pr.requested_reviewers) : q.includes("assignee:") ? mine(pr.assignees) : false;
        if (!matched) return { total_count: 0, incomplete_results: false, items: [] };
        return {
          total_count: 1,
          incomplete_results: false,
          items: [{ number: fixture.pr, repository_url: apiBase, html_url: pr.html_url, updated_at: pr.updated_at, pull_request: { draft: false } }],
        };
      },
    },
    {
      // How a stack link is found: the PR whose head is this PR's base branch.
      match: (method, p) => method === "GET" && p === `${apiBase}/pulls`,
      handle: (query = {}) => (fixture.stackPulls ?? []).filter((pull) => `${fixture.owner}:${pull.head.ref}` === query.head),
    },
    {
      match: (method, p) => method === "GET" && p.startsWith(`${apiBase}/pulls/${fixture.pr}/files`),
      handle: () => fixture.files,
    },
    {
      match: (method, p) => method === "GET" && p.startsWith(`${apiBase}/pulls/${fixture.pr}/commits`),
      handle: () => [{ sha: fixture.head.sha, commit: { message: fixture.commitSubject }, author: { login: "dev-author" } }],
    },
    {
      match: (method, p) => method === "GET" && p.startsWith(`${apiBase}/pulls/${fixture.pr}/reviews`),
      handle: () => (fixture.existingReviews ?? []),
    },
    {
      match: (method, p) => method === "GET" && p.startsWith(`${apiBase}/pulls/${fixture.pr}/comments`),
      handle: () => (fixture.existingComments ?? []),
    },
    {
      match: (method, p) => method === "GET" && p.startsWith(`${apiBase}/issues/${fixture.pr}/timeline`),
      handle: () => (fixture.timeline ?? timeline),
    },
    {
      match: (method, p) => method === "GET" && p === `${apiBase}/contents/CODEOWNERS`,
      handle: () => ({ content: Buffer.from("* @platform-team\n").toString("base64"), encoding: "base64" }),
    },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry = { method, path, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null };
      calls.push(entry);

      const authed = (req.headers.authorization ?? "").replace(/^Bearer /, "") === token;
      if (!authed) {
        res.writeHead(401, OK);
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }

      if (method === "POST" && path === `${apiBase}/pulls/${fixture.pr}/reviews`) {
        if (writeStatus !== 201) {
          res.writeHead(writeStatus, OK);
          res.end(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest/pulls/reviews" }));
          return;
        }
        const stateByEvent = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" };
        const review = {
          id: 900 + postedReviews.length,
          user: { login: me },
          state: stateByEvent[entry.body?.event] ?? "COMMENTED",
          html_url: `${pr.html_url}#pullrequestreview-${900 + postedReviews.length}`,
          commit_id: entry.body?.commit_id ?? null,
          submitted_at: new Date().toISOString(),
          body: entry.body?.body ?? "",
        };
        postedReviews.push({ ...review, comments: entry.body?.comments ?? [] });
        res.writeHead(201, OK);
        res.end(JSON.stringify(review));
        return;
      }

      const route = routes.find((candidate) => candidate.match(method, path));
      if (!route) {
        entry.violation = true;
        res.writeHead(404, OK);
        res.end(JSON.stringify({ message: `Not Found: ${method} ${path}` }));
        return;
      }
      res.writeHead(200, OK);
      res.end(JSON.stringify(route.handle(entry.query)));
    });
  });

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, token });
        });
      });
    },
    calls: () => calls,
    violations: () => calls.filter((call) => call.violation),
    writes: () => calls.filter((call) => call.method !== "GET"),
    postedReviews: () => postedReviews,
    /** Move the PR's head, which is how a re-review after a push is set up. */
    setHead: (sha) => {
      pr.head.sha = sha;
    },
    pr: () => pr,
    close() {
      server.close();
    },
  };
}
