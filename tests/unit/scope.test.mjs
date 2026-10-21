/**
 * Which repositories the bot may review.
 *
 * The bot posts as your own account, so an assignment in a repository you did not mean to automate
 * is the most expensive mistake the discovery path can make. These cases pin what each list admits.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { describeScope, matchRepository, scopeForSearchHit } from "../../src/github/scope.mjs";

test("no allow list means no repository", () => {
  const verdict = matchRepository("example/orders-svc", {});
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /both empty/);
  assert.equal(matchRepository("example/orders-svc", { orgs: [], repos: [], deny: [] }).allowed, false);
});

test("github.repos admits exact names and globs within one segment", () => {
  const admits = matchRepository("example/orders-svc", { repos: ["example/orders-svc"] });
  assert.equal(admits.allowed, true);
  assert.match(admits.reason, /github\.repos "example\/orders-svc"/);

  assert.equal(matchRepository("example/orders-svc", { repos: ["example/other"] }).allowed, false);
  assert.equal(matchRepository("example/orders-svc", { repos: ["example/*"] }).allowed, true);
  assert.equal(matchRepository("example/orders-worker", { repos: ["example/orders-*"] }).allowed, true);
  assert.equal(matchRepository("example/orders-svc", { repos: ["example/orders-*"] }).allowed, false);
  assert.equal(matchRepository("example/orders-svc", { repos: ["example/orders-sv?"] }).allowed, true);
  // `*` covers one segment, so it stands for any owner here but never for a deeper path.
  assert.equal(matchRepository("other/orders-svc", { repos: ["*/orders-svc"] }).allowed, true);
  assert.equal(matchRepository("a/b/orders-svc", { repos: ["**/orders-svc"] }).allowed, true);
  assert.equal(matchRepository("a/b/orders-svc", { repos: ["*/orders-svc"] }).allowed, false);
  // GitHub resolves owner and repository names regardless of case, so a lowercase pattern has to
  // admit the display casing the API reports back.
  assert.equal(matchRepository("ExampleCorp/Orders-Svc", { repos: ["examplecorp/orders-svc"] }).allowed, true);
  assert.equal(matchRepository("ExampleCorp/Orders-Worker", { repos: ["examplecorp/orders-*"] }).allowed, true);
});

test("github.orgs admits every repository of a listed owner", () => {
  assert.equal(matchRepository("example/orders-svc", { orgs: ["example"] }).allowed, true);
  assert.equal(matchRepository("example/anything-else", { orgs: ["example"] }).allowed, true);
  assert.equal(matchRepository("example/orders-svc", { orgs: ["EXAMPLE"] }).allowed, true);
  // A prefix of the owner is not the owner.
  assert.equal(matchRepository("examples/orders-svc", { orgs: ["example"] }).allowed, false);
  assert.match(matchRepository("examples/orders-svc", { orgs: ["example"] }).reason, /outside github/);
  // `*` in orgs is read as every owner, which is the wide setting.
  assert.equal(matchRepository("anywhere/at-all", { orgs: ["*"] }).allowed, true);
});

test("github.deny outranks both allow lists", () => {
  const scope = { orgs: ["*"], deny: ["example/secret-*"] };
  assert.equal(matchRepository("example/secret-api", scope).allowed, false);
  assert.match(matchRepository("example/secret-api", scope).reason, /github\.deny/);
  assert.equal(matchRepository("example/orders-svc", scope).allowed, true);
  // Deny also carries a repository out of an allow list that named it directly.
  const listed = { repos: ["example/orders-svc"], deny: ["example/orders-svc"] };
  assert.equal(matchRepository("example/orders-svc", listed).allowed, false);
  assert.equal(matchRepository("Example/Orders-SVC", listed).allowed, false);
});

test("a search hit without owner and name is refused", () => {
  assert.equal(scopeForSearchHit({ repository_url: "" }, { orgs: ["*"] }).allowed, false);
  assert.equal(scopeForSearchHit({}, { orgs: ["*"] }).allowed, false);
  const hit = { repository_url: "https://api.github.com/repos/example/orders-svc", number: 143 };
  assert.equal(scopeForSearchHit(hit, { repos: ["example/orders-svc"] }).allowed, true);
});

test("describeScope prints the lists, or the fact that nothing is allowed", () => {
  assert.equal(describeScope({ orgs: [], repos: [], deny: [] }), "nothing: no repository is in scope until github.orgs or github.repos is set");
  assert.equal(
    describeScope({ orgs: ["example"], repos: ["other/things"], deny: ["example/secret-*"] }),
    "orgs: example; repos: other/things; deny: example/secret-*",
  );
});
