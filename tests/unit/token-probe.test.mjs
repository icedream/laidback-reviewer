/**
 * The startup probe that checks the credential really is contents-read-only.
 *
 * What matters here is that the probe cannot create a file: the base sha it sends is not an object,
 * so a writable token is stopped by validation and a scoped token is stopped by authorization.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GithubError } from "../../src/github/client.mjs";
import { probeContentsReadOnly } from "../../src/github/token-probe.mjs";

function stubClient({ status, allowWrite = false } = {}) {
  const calls = [];
  return {
    calls,
    putContents: async (owner, repo, path, payload) => {
      calls.push({ owner, repo, path, payload });
      if (allowWrite) return { content: {}, commit: {} };
      throw new GithubError({ method: "PUT", path: `/repos/${owner}/${repo}/contents/${path}`, status, message: "stubbed" });
    },
  };
}

test("403 on the contents write means the ceiling holds", async () => {
  const client = stubClient({ status: 403 });
  const probe = await probeContentsReadOnly({ client, repo: "example/orders-svc" });
  assert.equal(probe.verdict, "read_only");
  assert.match(probe.detail, /example\/orders-svc: contents write refused \(403\)/);

  const [call] = client.calls;
  assert.equal(call.path, ".laidback-reviewer-probe");
  // The point of the call: a base sha that exists nowhere, so validation stops it.
  assert.equal(call.payload.sha, "0".repeat(40));
  assert.match(call.payload.message, /probe/);
});

test("422 means the token can write contents, which is a startup failure", async () => {
  const probe = await probeContentsReadOnly({ client: stubClient({ status: 422 }), repo: "example/orders-svc" });
  assert.equal(probe.verdict, "can_write");
  assert.match(probe.detail, /accepted up to validation \(422\)/);
});

test("a contents write that succeeds is reported as can_write", async () => {
  const probe = await probeContentsReadOnly({ client: stubClient({ allowWrite: true }), repo: "example/orders-svc" });
  assert.equal(probe.verdict, "can_write");
  assert.match(probe.detail, /unexpectedly succeeded/);
});

test("an unhelpful answer proves nothing, and says so", async () => {
  for (const [status, expect] of [
    [404, /not visible to this token/],
    [401, /token was rejected/],
    [502, /502/],
  ]) {
    const probe = await probeContentsReadOnly({ client: stubClient({ status }), repo: "example/orders-svc" });
    assert.equal(probe.verdict, "unknown", `status ${status}`);
    assert.match(probe.detail, expect);
  }
});

test("a malformed probeRepo is caught before any request", async () => {
  const client = stubClient({ status: 403 });
  const probe = await probeContentsReadOnly({ client, repo: "orders-svc" });
  assert.equal(probe.verdict, "unknown");
  assert.match(probe.detail, /not owner\/name/);
  assert.equal(client.calls.length, 0);
});
