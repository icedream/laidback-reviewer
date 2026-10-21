/**
 * A repository the operator did not put in scope is ignored, cheaply.
 *
 * The check has to happen on the search result. After that point every further call costs quota, and
 * a review costs a model run, so an out-of-scope assignment should end at one search hit.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { findCandidates } from "../../src/discovery.mjs";
import { setupReviewRun } from "../helpers/run-env.mjs";

/** Paths the fake GitHub was asked for, so the assertions are about work actually done. */
const paths = (env) => env.github.calls().map((call) => `${call.method} ${call.path}`);

test("an out-of-scope repository is rejected on the search hit, before the pull is fetched", async () => {
  const env = await setupReviewRun({ overrides: { github: { orgs: [], repos: ["other/things"] } } });
  try {
    const { candidates, rejected } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 0, "the fixture repository is not in scope");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /outside github\.orgs and github\.repos/);

    const seen = paths(env);
    assert.equal(seen.length, 1, `one search call and nothing else, saw: ${seen.join(", ")}`);
    assert.match(seen[0], /GET \/search\/issues/);
  } finally {
    env.close();
  }
});

test("empty allow lists review nothing, and the reason says so", async () => {
  const env = await setupReviewRun({ overrides: { github: { orgs: [], repos: [] } } });
  try {
    const { candidates, rejected } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(candidates.length, 0);
    assert.match(rejected[0].reason, /both empty/);
    assert.equal(paths(env).length, 1);
  } finally {
    env.close();
  }
});

test("a denied repository never reaches the model or GitHub writes", async () => {
  // In scope by org, then named away by deny: the order matters, because the allow list would
  // otherwise admit it.
  const env = await setupReviewRun({ overrides: { github: { orgs: ["example"], deny: ["example/orders-svc"] } } });
  try {
    await env.cycle();

    assert.match(env.log(), /skip .*github\.deny "example\/orders-svc"/);
    assert.equal(env.store.db.prepare("SELECT COUNT(*) AS n FROM reviews").get().n, 0, "no review was composed");
    assert.deepEqual(env.store.listFailures(), [], "the model was never called, so nothing failed");
    assert.deepEqual(env.github.writes(), [], "nothing was posted");
  } finally {
    env.close();
  }
});

test("the repository in scope is reviewed as usual", async () => {
  const env = await setupReviewRun({ overrides: { github: { orgs: [], repos: ["example/orders-svc"] } } });
  try {
    const { candidates, rejected } = await findCandidates({ cfg: env.cfg, client: env.client, store: env.store });

    assert.equal(rejected.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].repo, "orders-svc");
    assert.equal(candidates[0].pr, env.fixture.pr);
  } finally {
    env.close();
  }
});
