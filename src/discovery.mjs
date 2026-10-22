/**
 * Which PRs count as the bot's work. GitHub separates the paths in its data, `requested_reviewers`
 * for users and `requested_teams` for teams, so team membership needs no guessing. Provenance is not
 * in the data, only the `actor`, so the stricter policies below are best effort.
 */

import { scopeForSearchHit } from "./github/scope.mjs";

const AUTO_ASSIGN_WINDOW_MS = 5 * 60 * 1000;

export function isAssignedTo(pr, me) {
  return (pr.assignees ?? []).some((assignee) => assignee.login?.toLowerCase() === me.toLowerCase());
}

/** A request to me, not to a group I belong to: `requested_reviewers` only ever holds users. */
export function isRequestedReviewer(pr, me) {
  return (pr.requested_reviewers ?? []).some((reviewer) => reviewer.login?.toLowerCase() === me.toLowerCase());
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

/** Team request events carry `requested_team` and no `requested_reviewer`, so they never match here. */
function requestedEvents(events, me) {
  return (events ?? []).filter(
    (event) => event.event === "review_requested" && event.requested_reviewer?.login?.toLowerCase() === me.toLowerCase(),
  );
}

/**
 * The newest review request addressed to me that landed after this head was last handled. Empty when the
 * only requests predate that pass, which is what keeps one request from reopening the head forever.
 */
export function latestRequestAt(events, me, handledAt) {
  const later = requestedEvents(events, me)
    .map((event) => event.created_at ?? "")
    .filter((at) => at && at > handledAt);
  return later.sort().at(-1) ?? "";
}

const triggerLabel = (kind) => (kind === "assigned" ? "assigned" : "review requested");

/**
 * @param kind "review_requested" or "assigned", the search that produced the hit.
 * @returns {{ eligible: boolean, reason: string }}
 */
export function classifyTrigger({ pr, events, me, policy, kind, codeownersContent, changedPaths }) {
  const label = triggerLabel(kind);
  if (kind === "review_requested" ? !isRequestedReviewer(pr, me) : !isAssignedTo(pr, me)) {
    if (kind !== "review_requested") return { eligible: false, reason: "not assigned to me" };
    const users = (pr.requested_reviewers ?? []).map((reviewer) => reviewer.login).join(", ") || "none";
    const teams = (pr.requested_teams ?? []).map((team) => team.slug ?? team.name).join(", ") || "none";
    return { eligible: false, reason: `not an individually requested reviewer (reviewers: ${users}; teams: ${teams})` };
  }

  const eventsForMe = kind === "review_requested" ? requestedEvents(events, me) : assignedEvents(events, me);
  // The requester decides, never the PR author: a bot-authored PR that a person asked me to look at
  // still counts, and so does asking myself.
  const humanEvent = eventsForMe.find((event) => !isAutomationActor(event.actor));
  if (policy === "any") {
    return { eligible: true, reason: `${label} to me (${eventsForMe[0]?.actor?.login ?? "actor unknown"})` };
  }

  if (policy === "human_actor") {
    if (!eventsForMe.length) return { eligible: true, reason: `${label}, no matching event in the timeline window: treated as human` };
    if (humanEvent) return { eligible: true, reason: `${label} by ${humanEvent.actor.login}` };
    const actors = eventsForMe.map((event) => event.actor?.login ?? "?").join(", ");
    return { eligible: false, reason: `${label} only by automation actors (${actors})` };
  }

  // exclude_codeowners: an automatic trigger lands within seconds of PR creation, and only for a
  // CODEOWNERS owner covering the changed paths. Both halves must hold.
  const rules = parseCodeowners(codeownersContent);
  if (!rules.length) return { eligible: true, reason: "no CODEOWNERS rules in this repository" };

  const latest = eventsForMe.at(-1);
  const createdAt = pr.created_at ? Date.parse(pr.created_at) : 0;
  const setAt = latest?.created_at ? Date.parse(latest.created_at) : 0;
  const nearOpen = setAt && createdAt && Math.abs(setAt - createdAt) <= AUTO_ASSIGN_WINDOW_MS;
  const owners = matchedCodeowners(rules, changedPaths).flatMap((rule) => rule.owners);
  const namesMe = owners.some((owner) => {
    const name = owner.replace(/^@/, "").toLowerCase();
    return name === me.toLowerCase() || name.endsWith(`/${me.toLowerCase()}`);
  });

  if (nearOpen && namesMe) {
    return { eligible: false, reason: `${label} matches a CODEOWNERS rule for the changed paths and landed at PR open (best effort)` };
  }
  if (!eventsForMe.length || !humanEvent) {
    return { eligible: false, reason: `${label} actor ${eventsForMe.at(-1)?.actor?.login ?? "?"} looks automated` };
  }
  return { eligible: true, reason: `${label} is not explained by CODEOWNERS (owners for these paths: ${owners.join(", ") || "none"})` };
}

export function repositoryFromSearchHit(item) {
  const fullName = String(item.repository_url ?? "").replace(/^.*\/repos\//, "");
  const [owner, repo] = fullName.split("/");
  return owner && repo ? { owner, repo, number: item.number } : null;
}

/**
 * Candidate PRs: search results for the configured trigger, minus out-of-scope repositories, minus
 * what state says is handled, minus what the provenance policy rejects. The search cursor moves to the
 * newest update it saw, so a PR only comes back if it was touched again.
 */
export async function findCandidates({ cfg, client, store, now = new Date() }) {
  const cursorIso = store.getMeta("search_updated_at") ?? new Date(now.getTime() - cfg.github.searchAgeHours * 3600_000).toISOString();
  // Search cannot OR qualifiers: one query per mode, review requests first.
  const modes = cfg.trigger.mode === "both" ? ["review_requested", "assigned"] : [cfg.trigger.mode];
  const hits = [];
  for (const kind of modes) {
    const search =
      kind === "assigned"
        ? await client.searchAssigned({ me: cfg.github.me, sinceIso: cursorIso })
        : await client.searchReviewRequested({ me: cfg.github.me, sinceIso: cursorIso });
    for (const item of search.items ?? []) hits.push({ item, kind });
  }

  const candidates = [];
  const rejected = [];
  const seen = new Set();
  let newest = cursorIso;

  for (const { item, kind } of hits) {
    const hitKey = `${item.repository_url}#${item.number}`;
    if (seen.has(hitKey)) continue;
    seen.add(hitKey);

    if (item.pull_request?.draft && cfg.trigger.skipDraft) {
      rejected.push({ pr: item.number, reason: "draft" });
      continue;
    }
    const located = repositoryFromSearchHit(item);
    if (!located) continue;
    // Scope first: an out-of-sight repository costs one search hit and no further calls.
    const scope = scopeForSearchHit(item, cfg.github);
    if (!scope.allowed) {
      rejected.push({ pr: located, reason: scope.reason });
      continue;
    }
    if (item.updated_at && item.updated_at > newest) newest = item.updated_at;

    const pr = await client.getPull(located.owner, located.repo, located.number);
    const handled = store.seenFor({ owner: located.owner, repo: located.repo, pr: located.number, head_sha: pr.head.sha });
    let reRequest = null;
    if (handled && !cfg.reviews.respondToReRequest) continue;

    // The timeline says whether a request arrived after the earlier pass, so it is read once here and
    // reused by the trigger classification below.
    const events = await client.listTimeline(located.owner, located.repo, located.number);

    if (handled) {
      const askedAt = latestRequestAt(events, cfg.github.me, handled.checked_at);
      if (!askedAt) continue;
      if ((handled.rereviews ?? 0) >= cfg.reviews.maxReReviewsPerHead) {
        rejected.push({ pr: `${located.owner}/${located.repo}#${located.number}`, reason: `re-review ceiling for this head (${cfg.reviews.maxReReviewsPerHead}) already reached` });
        continue;
      }
      reRequest = { askedAt, handledAt: handled.checked_at, rereviews: handled.rereviews ?? 0 };
    }

    const wantsCodeowners = cfg.trigger.policy === "exclude_codeowners";
    const decision = classifyTrigger({
      pr,
      events,
      me: cfg.github.me,
      policy: cfg.trigger.policy,
      kind,
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
      // The request this candidate answers. A gate records it, so the same request cannot gate the head
      // twice and a newer one can.
      requestTs: latestRequestAt(events, cfg.github.me, ""),
      reRequest,
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
