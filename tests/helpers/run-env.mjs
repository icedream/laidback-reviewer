/**
 * Shared test setup: fixture repo, fake GitHub, scripted model, Pi agent dir with the fake provider,
 * a written config file, and one review run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../../src/config.mjs";
import { openStore } from "../../src/proposal/store.mjs";
import { createGithubClient } from "../../src/github/client.mjs";
import { createFakeGithubApi } from "../fakes/github-api.mjs";
import { createScriptedModel, reviewScript } from "../fakes/model.mjs";
import { buildFixtureRepo } from "../fixtures/repo.mjs";
import { runReview } from "../../src/review-run.mjs";

export const FAKE_MODEL_PROVIDER = "laidback-fake";
export const FAKE_MODEL_ID = "scripted-review";

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(base[key] ?? {}, value) : value;
  }
  return out;
}

export function baseConfig({ dir }) {
  return {
    github: { me: "octocat", tokenEnv: "LAIDBACK_TEST_TOKEN", orgs: ["example"], repos: [] },
    assignment: { policy: "any", includeReviewRequests: false, skipDraft: true },
    reviews: {
      rereviewOnPush: false,
      maxPerCycle: 2,
      maxComments: 25,
      dryRun: true,
      approve: "hint",
      requestChanges: "hint",
      hintWording: {
        approve: "Verdict: I would have approved this.",
        requestChanges: "Verdict: I would have requested changes.",
      },
    },
    banner: { prefix: "", suffix: "<sub>This review was performed by a local AI bot.</sub>", rephrase: false },
    agent: {
      name: "test-reviewer",
      agentDir: path.join(dir, "agent", "agents"),
      skillsDir: "",
      systemPromptAddendum: "",
      model: { provider: FAKE_MODEL_PROVIDER, id: FAKE_MODEL_ID, thinking: "off", maxConcurrency: 1, busyBackoffMs: 0 },
    },
    context: { enabled: false, maxAgeDays: 30, minScore: 35, allowCrossRepo: false, sessionDir: "", mode: "auto", maxForkTokens: 48000 },
    checkout: { mode: "existing", root: path.join(dir, "repos"), scratch: path.join(dir, "scratch"), compareDir: path.join(dir, "scratch", "refs"), gitConfig: path.join(dir, "gitconfig"), existingDir: "", goPrivate: [] },
    tools: { bash: true, mcp: [], allowHosts: ["127.0.0.1", "api.github.com"] },
    gate: {
      channel: "none",
      beforeReview: false,
      beforePost: true,
      timeoutHours: 24,
      onTimeout: "hold",
      maxPending: 5,
      slack: { transport: "userToken", channelEnv: "LAIDBACK_SLACK_CHANNEL", channelName: "gate", allowUsersEnv: "LAIDBACK_SLACK_USERS", tokenEnv: "LAIDBACK_TEST_SLACK_TOKEN", cookieEnv: "LAIDBACK_TEST_SLACK_COOKIE", webhookUrlEnv: "LAIDBACK_TEST_SLACK_WEBHOOK" },
    },
  };
}

/**
 * Bring up one review run. `overrides` is a partial config tree, so each test reads as a policy
 * difference rather than a new environment.
 */
export async function setupReviewRun({ overrides = {}, scriptOptions = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laidback-test-"));
  fs.mkdirSync(path.join(dir, "scratch"), { recursive: true });

  const fixture = buildFixtureRepo({ dir: path.join(dir, "repos", "orders-svc") });
  const github = createFakeGithubApi({ fixture, me: "octocat", token: "test-token" });
  const { baseUrl: githubBaseUrl } = await github.start();

  const model = createScriptedModel({ turns: reviewScript({ fixture, scratchDir: fixture.dir, ...scriptOptions }) });
  const { baseUrl: modelBaseUrl } = await model.start();

  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          [FAKE_MODEL_PROVIDER]: {
            api: "openai-completions",
            apiKey: "test-key",
            baseUrl: modelBaseUrl,
            models: [{ id: FAKE_MODEL_ID, name: "Scripted review model", contextWindow: 131072, reasoning: false }],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.copyFileSync(
    new URL("../fixtures/agents/test-reviewer.md", import.meta.url),
    path.join(agentDir, "agents", "test-reviewer.md"),
  );

  // A skill in the agent dir: the agent file cites skills as its standard, so replacing the system
  // prompt must not drop the skill listing.
  fs.mkdirSync(path.join(agentDir, "skills", "demo-guidelines"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "skills", "demo-guidelines", "SKILL.md"),
    "---\nname: demo-guidelines\ndescription: \"Test skill: the review standard the agent is expected to cite.\"\n---\n\n# Demo guidelines\n\nName the file, not the convention.\n",
  );

  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, stringify(merge(baseConfig({ dir }), overrides)));
  const cfg = loadConfig({ path: configPath, env: { LAIDBACK_TEST_TOKEN: "test-token", ...env } });

  const store = openStore(path.join(dir, "state.db"));
  const client = createGithubClient({ baseUrl: githubBaseUrl, token: "test-token" });
  const logLines = [];
  const log = (line) => logLines.push(String(line));

  const run = () =>
    runReview({
      cfg,
      store,
      client,
      task: { owner: fixture.owner, repo: fixture.repo, pr: fixture.pr, checkoutDir: fixture.dir },
      piAgentDir: agentDir,
      artifactDir: path.join(dir, "reviews"),
      log,
    });

  const close = () => {
    store.close();
    github.close();
    model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, cfg, fixture, github, model, store, client, run, close, log: () => logLines.join("\n") };
}
