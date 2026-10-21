/**
 * Which repositories the bot is allowed to touch.
 *
 * The search query cannot express an OR over repositories, so the filter runs client-side on
 * `repository_url`. It is the difference between "assigned to me anywhere I have a token" and
 * "assigned to me in the projects I want a machine reviewing", and it is checked before any per-PR
 * API call so an ignored repository costs one search result and nothing else.
 */

/**
 * Glob to regex. `*` stays inside one path segment, so `example/orders-*` matches repositories in that
 * org and `*` alone matches any org. `**` crosses the slash. Matching is case-insensitive because
 * GitHub treats names that way.
 */
function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

function compile(list) {
  return (list ?? []).map((pattern) => ({ pattern: String(pattern).trim(), re: patternToRegExp(String(pattern).trim()) }));
}

/**
 * @param fullName "owner/name" as GitHub reports it
 * @param scope { orgs, repos, deny } from config; empty allow lists mean nothing is allowed
 */
export function matchRepository(fullName, scope) {
  const name = String(fullName ?? "").trim();
  if (!name || !name.includes("/")) return { allowed: false, reason: "search result has no owner/name" };

  const org = name.split("/")[0];
  const deny = compile(scope.deny).find(({ re }) => re.test(name));
  if (deny) return { allowed: false, reason: `matches github.deny "${deny.pattern}"` };

  const repoRule = compile(scope.repos).find(({ re }) => re.test(name));
  if (repoRule) return { allowed: true, reason: `matches github.repos "${repoRule.pattern}"` };

  // `orgs` lists owners, so a pattern there is tried against the owner segment as well as the whole
  // name: `example` and `example/*` both admit example/anything, and `*` admits every org.
  const orgRule = compile(scope.orgs).find(({ pattern, re }) => re.test(name) || re.test(org) || pattern.toLowerCase() === org.toLowerCase());
  if (orgRule) return { allowed: true, reason: `matches github.orgs "${orgRule.pattern}"` };

  if (!(scope.orgs ?? []).length && !(scope.repos ?? []).length) {
    return { allowed: false, reason: "github.orgs and github.repos are both empty, so no repository is in scope" };
  }
  return { allowed: false, reason: "outside github.orgs and github.repos" };
}

/** Convenience for a search hit. */
export function scopeForSearchHit(item, scope) {
  const fullName = String(item?.repository_url ?? "").replace(/^.*\/repos\//, "");
  return matchRepository(fullName, scope);
}

/** Human-readable summary for the startup line. */
export function describeScope(scope) {
  const parts = [];
  if ((scope.orgs ?? []).length) parts.push(`orgs: ${scope.orgs.join(", ")}`);
  if ((scope.repos ?? []).length) parts.push(`repos: ${scope.repos.join(", ")}`);
  if ((scope.deny ?? []).length) parts.push(`deny: ${scope.deny.join(", ")}`);
  return parts.length ? parts.join("; ") : "nothing: no repository is in scope until github.orgs or github.repos is set";
}
