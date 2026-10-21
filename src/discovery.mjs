/**
 * Which assignments to act on.
 *
 * GitHub assigns pull requests to individuals only, so `assignee:<me>` is already direct: a team
 * review request never touches the assignee list. What the timeline does not distinguish is
 * provenance, only the `actor` who generated the event, so the stricter policies below are best
 * effort and say so in the reason they return.
 */

import { scopeForSearchHit } from "./github/scope.mjs";

const AUTO_ASSIGN_WINDOW_MS = 5 * 60 * 1000;

export function isAssignedTo(pr, me) {
  return (pr.assignees ?? []).some((assignee) => assignee.login?.toLowerCase() === me.toLowerCase());
}

function isAutomationActor(actor) {
  if (!actor) return false;
  const login = (actor.login ?? "").toLowerCase();
  return actor.type === "Bot" || actor.type === "Organization" || login.endsWith("[bot]") || login === "github-actions" || login === "dependabot";
}

/** Minimal CODEOWNERS reader: rules that matched changed paths, with the owners they name. */
export function parseCodeowners(content) {
  const rules = [];
  for (const rawLine of String(content ?? "").split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length) rules.push({ pattern, owners });
  }
  return rules;
}

export function matchedCodeowners(rules, paths) {
  return rules.filter((rule) => paths.some((file) => matchesCodeownerPath(rule.pattern, file)));
}

/**
 * GitHub's own matching: a rule ending in `/` is a directory prefix, a rule with no slash matches
 * like a gitignore glob at any depth, and `**` crosses directories while `*` does not.
 */
function matchesCodeownerPath(pattern, file) {
  if (pattern === "*") return true;
  const normalized = pattern.replace(/^\//, "");
  if (normalized.endsWith("/")) return file.startsWith(normalized);
  const anchor = normalized.includes("/") ? "^" : "(^|/)";
  const body = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`${anchor}${body}$`).test(file);
}

function assignedEvents(events, me) {
  return (events ?? []).filter((event) => event.event === "assigned" && event.assignee?.login?.toLowerCase() === me.toLowerCase());
}

/**
 * @returns {{ eligible: boolean, reason: string }}
 */
export function classifyAssignment({ pr, events, me, policy, codeownersContent, changedPaths }) {
  if (!isAssignedTo(pr, me)) return { eligible: false, reason: "not assigned to me" };

  const eventsForMe = assignedEvents(events, me);
  if (policy === "any") {
    return { eligible: true, reason: `assigned to me (${eventsForMe[0]?.actor?.login ?? "actor unknown"})` };
  }

  if (policy === "human_actor") {
    if (!eventsForMe.length) return { eligible: true, reason: "assigned, no assignment event in the timeline window: treated as human" };
    const latest = eventsForMe.at(-1);
    if (isAutomationActor(latest.actor)) return { eligible: false, reason: `assignment actor ${latest.actor.login} looks automated` };
    return { eligible: true, reason: `assigned by ${latest.actor.login}` };
  }

  // exclude_codeowners: the auto-assignment GitHub writes lands within seconds of PR creation, and
  // only for an owner that a CODEOWNERS rule covers for the changed paths. Both halves must hold to
  // call it automatic.
  const rules = parseCodeowners(codeownersContent);
  if (!rules.length) return { eligible: true, reason: "no CODEOWNERS rules in this repository" };

  const latest = eventsForMe.at(-1);
  const createdAt = pr.created_at ? Date.parse(pr.created_at) : 0;
  const assignedAt = latest?.created_at ? Date.parse(latest.created_at) : 0;
  const nearOpen = assignedAt && createdAt && Math.abs(assignedAt - createdAt) <= AUTO_ASSIGN_WINDOW_MS;
  const owners = matchedCodeowners(rules, changedPaths).flatMap((rule) => rule.owners);
  const namesMe = owners.some((owner) => {
    const name = owner.replace(/^@/, "").toLowerCase();
    return name === me.toLowerCase() || name.endsWith(`/${me.toLowerCase()}`);
  });

  if (nearOpen && namesMe) {
    return { eligible: false, reason: "assignment matches a CODEOWNERS rule for the changed paths and landed at PR open (best effort)" };
  }
  if (isAutomationActor(latest?.actor)) return { eligible: false, reason: `assignment actor ${latest?.actor?.login ?? "?"} looks automated` };
  return { eligible: true, reason: `assignment is not explained by CODEOWNERS (owners for these paths: ${owners.join(", ") || "none"})` };
}

export function repositoryFromSearchHit(item) {
  const fullName = String(item.repository_url ?? "").replace(/^.*\/repos\//, "");
  const [owner, repo] = fullName.split("/");
  return owner && repo ? { owner, repo, number: item.number } : null;
}

/**
 * Candidate PRs: search results, minus what state says is handled, minus what the assignment policy
 * rejects. The search cursor moves to the newest update it saw, so a PR only comes back if it was
 * touched again.
 */
export async function findCandidates({ cfg, client, store, now = new Date() }) {
  const cursorIso = store.getMeta("search_updated_at") ?? new Date(now.getTime() - cfg.github.searchAgeHours * 3600_000).toISOString();
  const search = await client.searchAssigned({ me: cfg.github.me, sinceIso: cursorIso });

  const candidates = [];
  const rejected = [];
  let newest = cursorIso;

  for (const item of search.items ?? []) {
    if (item.pull_request?.draft) {
      rejected.push({ pr: item.number, reason: "draft" });
      continue;
    }
    const located = repositoryFromSearchHit(item);
    if (!located) continue;
    // Scope before anything else: an out-of-sight repository costs one search result, not a pull
    // fetch, a timeline fetch and a CODEOWNERS fetch.
    const scope = scopeForSearchHit(item, cfg.github);
    if (!scope.allowed) {
      rejected.push({ pr: located, reason: scope.reason });
      continue;
    }
    if (item.updated_at && item.updated_at > newest) newest = item.updated_at;

    const pr = await client.getPull(located.owner, located.repo, located.number);
    if (store.alreadyHandled({ owner: located.owner, repo: located.repo, pr: located.number, head_sha: pr.head.sha }) && !cfg.reviews.rereviewOnPush) {
      continue;
    }

    const events = await client.listTimeline(located.owner, located.repo, located.number);
    const wantsCodeowners = cfg.assignment.policy === "exclude_codeowners";
    const decision = classifyAssignment({
      pr,
      events,
      me: cfg.github.me,
      policy: cfg.assignment.policy,
      codeownersContent: wantsCodeowners ? await fetchCodeowners(client, located) : "",
      changedPaths: wantsCodeowners ? (await client.listFiles(located.owner, located.repo, located.number)).map((file) => file.filename) : [],
    });

    if (!decision.eligible) {
      rejected.push({ pr: `${located.owner}/${located.repo}#${located.number}`, reason: decision.reason });
      continue;
    }

    candidates.push({
      owner: located.owner,
      repo: located.repo,
      pr: located.number,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      htmlUrl: pr.html_url,
      reason: decision.reason,
    });
  }

  store.setMeta("search_updated_at", newest);
  const cap = cfg.reviews.maxPerCycle;
  return { candidates: candidates.slice(0, cap), deferred: candidates.slice(cap), rejected, cursorIso };
}

async function fetchCodeowners(client, { owner, repo }) {
  try {
    const found = await client.request("GET", `/repos/${owner}/${repo}/contents/CODEOWNERS`);
    return Buffer.from(found.content ?? "", "base64").toString("utf8");
  } catch {
    // GitHub also keeps CODEOWNERS under .github/, and a repository may have none at all.
    try {
      const found = await client.request("GET", `/repos/${owner}/${repo}/contents/.github/CODEOWNERS`);
      return Buffer.from(found.content ?? "", "base64").toString("utf8");
    } catch {
      return "";
    }
  }
}
