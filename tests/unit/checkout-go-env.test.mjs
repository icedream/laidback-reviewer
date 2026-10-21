/**
 * The Go environment a review's gates run in.
 *
 * GOPRIVATE decides whether `go test` can resolve a private module at all, and GOPROXY decides where
 * the fetch goes. A mirror that is not in tools.allowHosts is refused by the guard, so both halves
 * have to agree.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { configureGoModules } from "../../src/checkout.mjs";

function withCleanGoEnv(run) {
  const saved = ["GOPRIVATE", "GOPROXY", "GOSUMDB", "GOFLAGS"].map((name) => [name, process.env[name]]);
  for (const name of saved.map(([name]) => name)) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("private patterns and a mirror both reach the environment", () => {
  const logged = [];
  withCleanGoEnv(() => {
    configureGoModules({
      cfg: {
        checkout: {
          goPrivate: ["github.com/example-corp/*"],
          goProxy: "https://athens.internal:3000,direct",
          goSumDb: "off",
          goFlags: "-mod=mod",
        },
      },
      log: (line) => logged.push(line),
    });

    assert.equal(process.env.GOPRIVATE, "github.com/example-corp/*");
    assert.equal(process.env.GOPROXY, "https://athens.internal:3000,direct");
    assert.equal(process.env.GOSUMDB, "off");
    assert.equal(process.env.GOFLAGS, "-mod=mod");
  });

  assert.deepEqual(logged, [
    "GOPRIVATE=github.com/example-corp/*",
    "GOPROXY=https://athens.internal:3000,direct",
    "GOSUMDB=off",
    "GOFLAGS=-mod=mod",
  ]);
});

test("unset keys stay out of the environment", () => {
  withCleanGoEnv(() => {
    configureGoModules({ cfg: { checkout: { goPrivate: [], goProxy: "", goSumDb: "", goFlags: "" } }, log: () => {} });
    for (const name of ["GOPRIVATE", "GOPROXY", "GOSUMDB", "GOFLAGS"]) assert.equal(process.env[name], undefined);
  });
});
