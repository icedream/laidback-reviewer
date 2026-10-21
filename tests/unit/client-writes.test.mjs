/**
 * The write ceiling. A token with the wrong grants cannot turn this client into a contents writer,
 * and nothing has to be written to find that out.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assertWriteAllowed, createGithubClient } from "../../src/github/client.mjs";

test("only a review submission is an allowed write", () => {
  assert.equal(assertWriteAllowed("POST", "/repos/example/orders-svc/pulls/143/reviews"), undefined);

  for (const [method, path] of [
    ["PUT", "/repos/example/orders-svc/contents/.laidback-reviewer-probe"],
    ["PUT", "/repos/example/orders-svc/contents/config.yaml"],
    ["DELETE", "/repos/example/orders-svc/contents/config.yaml"],
    ["POST", "/repos/example/orders-svc/issues/143/comments"],
    ["POST", "/repos/example/orders-svc/git/refs"],
    ["PATCH", "/repos/example/orders-svc/pulls/143"],
    ["POST", "/repos/example/orders-svc/pulls/143/reviews/extra"],
    ["POST", "/repos/other/pulls/1/reviews/../merge"],
  ]) {
    assert.throws(() => assertWriteAllowed(method, path), /writes only to a pull-request review endpoint/, `${method} ${path}`);
  }
});

test("reads are never questioned", () => {
  for (const [method, path] of [["GET", "/repos/example/orders-svc"], ["GET", "/search/issues?q=is%3Apr"], ["HEAD", "/ratelimit"]]) {
    assert.equal(assertWriteAllowed(method, path), undefined);
  }
});

test("a disallowed write is refused before the request leaves the process", async () => {
  let attempts = 0;
  const client = createGithubClient({
    token: "t",
    fetchImpl: async () => {
      attempts += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await assert.rejects(() => client.request("PUT", "/repos/example/orders-svc/contents/x"), /refused/);
  assert.equal(attempts, 0, "no network call was made");
  assert.equal(client.putContents, undefined, "the contents write method is gone, not merely unused");

  await client.postReview("example", "orders-svc", 143, { event: "COMMENT" });
  assert.equal(attempts, 1, "the review write is allowed through");
});
