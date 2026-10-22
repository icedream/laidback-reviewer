/**
 * Configuration loading.
 *
 * Fail-closed: an unknown key is an error rather than a ignored typo, because a
 * silently dropped key could be a permission narrowing (an allowlist, a policy mode).
 */

import fs from "node:fs";
import nodePath from "node:path";
import { parse as parseYaml } from "yaml";

const string = (opts = {}) => ({ kind: "string", ...opts });
const integer = (opts = {}) => ({ kind: "integer", ...opts });
const bool = (opts = {}) => ({ kind: "boolean", ...opts });
const enumerated = (values, opts = {}) => ({ kind: "enum", values, ...opts });
const list = (item, opts = {}) => ({ kind: "list", item, ...opts });
const record = (schema, opts = {}) => ({ kind: "record", schema, ...opts });

export const CONFIG_SCHEMA = record({
  github: record({
    me: string({ required: true }),
    tokenEnv: string({ def: "LAIDBACK_GH_TOKEN" }),
    orgs: list(string(), { def: [] }),
    repos: list(string(), { def: [] }),
    deny: list(string(), { def: [] }),
    pollIntervalMs: integer({ def: 120_000, min: 15_000 }),
    timeoutMs: integer({ def: 30_000, min: 1_000 }),
    searchAgeHours: integer({ def: 24, min: 1 }),
    // How far back the search window reaches past the stored cursor, so a PR updated in the same second as
    // the cursor was written is not lost between polls.
    cursorOverlapMs: integer({ def: 120_000, min: 0 }),
  }),
  trigger: record({
    // A team request never qualifies under any mode: it lands on requested_teams, not the reviewer list.
    mode: enumerated(["review_requested", "assigned", "both"], { def: "review_requested" }),
    policy: enumerated(["any", "human_actor", "exclude_codeowners"], { def: "any" }),
    skipDraft: bool({ def: true }),
  }),
  // Deprecated spelling, translated into `trigger` by loadConfig.
  assignment: record({
    policy: enumerated(["any", "human_actor", "exclude_codeowners"], { def: "any" }),
    skipDraft: bool({ def: true }),
  }),
  reviews: record({
    // A review request that arrives after a head was already handled reopens it: the head did not move,
    // the ask did. Capped, because a bot that keeps re-requesting would otherwise post without limit.
    respondToReRequest: bool({ def: true }),
    maxReReviewsPerHead: integer({ def: 3, min: 0 }),
    // Deprecated. A moved head is a new key, so it is reviewed again whatever this says; set to true it
    // only ever bypassed the seen table and re-posted the same head every cycle. Translated away below.
    rereviewOnPush: bool({ def: false }),
    maxPerCycle: integer({ def: 2, min: 1 }),
    maxComments: integer({ def: 25, min: 1 }),
    dryRun: bool({ def: true }),
    approve: enumerated(["submit", "hint", "drop"], { def: "hint" }),
    requestChanges: enumerated(["submit", "hint", "drop"], { def: "hint" }),
    hintWording: record({
      approve: string({ def: "Verdict: I would have approved this." }),
      requestChanges: string({ def: "Verdict: I would have requested changes." }),
    }),
    // One review gets a wall clock. Over it the session is cancelled and the head records a failure,
    // so the next attempt arrives under the normal spacing instead of the run sitting there.
    budgetMs: integer({ def: 1_200_000, min: 60_000 }),
    // Failures are recorded per (pr, head): the next attempt waits, and a head that keeps failing is
    // parked.
    maxAttemptsPerHead: integer({ def: 4, min: 1 }),
    retryBaseMs: integer({ def: 120_000, min: 1_000 }),
    retryMaxMs: integer({ def: 21_600_000, min: 1_000 }),
  }),
  banner: record({
    prefix: string({ def: "" }),
    suffix: string({ def: "" }),
    // authored: the review is told to write the notice into its own text, and the harness fills a slot only
    // where the notice is missing. appended: the harness stitches both slots every time.
    mode: enumerated(["authored", "appended"], { def: "authored" }),
    // Whether a notice the harness has to add is reworded to fit the review. Per slot, because a suffix is
    // often a fixed footer that should not move.
    rephrasePrefix: bool({ def: false }),
    rephraseSuffix: bool({ def: false }),
    // Deprecated: sets both flags. Translated below.
    rephrase: bool({ def: false }),
  }),
  logging: record({
    // debug adds what the harness decided, not only what it did: the queue probe, the proposal as
    // recorded, the policy mapping, the checkout and linter it settled on.
    level: enumerated(["normal", "debug"], { def: "normal" }),
    // tools prints each tool call as the session makes it; full also prints how each one ended.
    progress: enumerated(["off", "tools", "full"], { def: "tools" }),
    heartbeatMs: integer({ def: 15_000, min: 1_000 }),
    // How often the approved gate message is rewritten with what the session is doing. Telegram counts a
    // rewrite as a new message for rate-limit purposes, so this is deliberately slow.
    statusEveryMs: integer({ def: 20_000, min: 2_000 }),
    // The MCP extension appends a log. Empty means the agent dir, which the container mounts read-only.
    mcpLogFile: string({ def: "" }),
  }),
  agent: record({
    name: string({ def: "pr-review" }),
    agentDir: string({ def: ".pi/agent/agents" }),
    skillsDir: string({ def: "" }),
    // MCP servers connect in the background after the session exists. This bounds how long a run waits
    // for their tools before prompting without them; 0 never waits.
    mcpSettleMs: integer({ def: 8_000, min: 0 }),
    systemPromptAddendum: string({ def: "" }),
    model: record({
      provider: string({ required: true }),
      id: string({ required: true }),
      thinking: enumerated(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { def: "xhigh" }),
      maxConcurrency: integer({ def: 1, min: 1 }),
      lockFile: string({ def: "" }),
      busyBackoffMs: integer({ def: 30_000, min: 0 }),
      // Transient model errors re-prompt the same session before the run counts as a failure.
      busyRetries: integer({ def: 2, min: 0, max: 6 }),
      // One inference slot is shared with the interactive session, and a request queued behind another
      // still holds the connection. "auto" asks the server what it is doing before sending anything:
      // /status on Strata, /slots?model= on llama.cpp, and a one-token request that has to answer
      // quickly on anything else.
      probe: enumerated(["auto", "status", "slots", "latency", "none"], { def: "auto" }),
      statusUrl: string({ def: "" }),
      probeTimeoutMs: integer({ def: 3000, min: 250 }),
      latencyMs: integer({ def: 2500, min: 250 }),
      // A prompt that has produced nothing this long while the server is busy elsewhere is cancelled
      // rather than left in the queue.
      firstTokenMs: integer({ def: 45_000, min: 2_000 }),
      deferMs: integer({ def: 90_000, min: 5_000 }),
    }),
  }),
  toolchain: record({
    // "auto" takes the version the repository pins, "off" leaves the image's version alone, any
    // other value is a release tag fetched into installDir. Config schemas are not interchangeable
    // across linter majors.
    golangciLint: string({ def: "auto" }),
    installDir: string({ def: "work/tools" }),
    // Change for a mirror, an air-gapped network, or a test server.
    downloadBaseUrl: string({ def: "https://github.com" }),
    // A release download and an unpack both need deadlines: a stalled mirror otherwise holds the run.
    downloadTimeoutMs: integer({ def: 120_000, min: 1_000 }),
    execTimeoutMs: integer({ def: 120_000, min: 1_000 }),
        preferRepoVersion: bool({ def: true }),
  }),
  context: record({
    enabled: bool({ def: true }),
    maxAgeDays: integer({ def: 30, min: 1 }),
    minScore: integer({ def: 35, min: 0, max: 100 }),
    // Weakest link, and only ever used when nothing stronger matches, but still worth carrying: what an
    // earlier review concluded about go.mod can save a pass re-deriving it. Turn off if it gets noisy.
    crossPrFileOverlap: bool({ def: true }),
    allowCrossRepo: bool({ def: false }),
    sessionDir: string({ def: "" }),
    mode: enumerated(["auto", "fork", "digest"], { def: "auto" }),
    maxForkTokens: integer({ def: 48_000, min: 1000 }),
  }),
  checkout: record({
    mode: enumerated(["clone", "existing"], { def: "clone" }),
    root: string({ def: "work/repos" }),
    scratch: string({ def: "work/scratch" }),
    compareDir: string({ def: "work/scratch/refs" }),
    gitConfig: string({ def: ".pi/gitconfig" }),
    existingDir: string({ def: "" }),
    goPrivate: list(string(), { def: [] }),
    // Deadlines for the git calls the harness makes itself: a worktree add and a clone are different
    // pieces of work, so they get different ones.
    commandTimeoutMs: integer({ def: 60_000, min: 1_000 }),
    // A deferred pass keeps its tree so the resumed pass can go on reading it. Nothing keeps one longer
    // than this once no deferral points at it.
    keepScratchMs: integer({ def: 21_600_000, min: 600_000 }),
    transferTimeoutMs: integer({ def: 300_000, min: 5_000 }),
    // A private module proxy (Athens or similar) keeps a container off the public proxies; the host has
    // to appear in tools.allowHosts as well or the guard stops the fetch.
    goProxy: string({ def: "" }),
    goSumDb: string({ def: "" }),
    goFlags: string({ def: "" }),
  }),
  tools: record({
    bash: bool({ def: true }),
    mcp: list(string(), { def: [] }),
    allowHosts: list(string(), {
      def: ["github.com", "api.github.com", "raw.githubusercontent.com", "mcp.atlassian.com"],
    }),
  }),
  gate: record({
    channel: enumerated(["slack", "telegram", "cli", "none"], { def: "cli" }),
    beforeReview: bool({ def: false }),
    beforePost: bool({ def: true }),
    timeoutHours: integer({ def: 24, min: 1 }),
    onTimeout: enumerated(["hold", "skip"], { def: "hold" }),
    maxPending: integer({ def: 5, min: 1 }),
    // How often a waiting tap is read between discovery cycles. A decision should start the work in
    // seconds, while repository polling keeps its own, slower, interval.
    pollIntervalMs: integer({ def: 10_000, min: 1_000 }),
    telegram: record({
      botTokenEnv: string({ def: "TELEGRAM_BOT_TOKEN" }),
      chatIdEnv: string({ def: "TELEGRAM_CHAT_ID" }),
      chatId: string({ def: "" }),
      allowUsersEnv: string({ def: "LAIDBACK_TELEGRAM_USERS" }),
      timeoutMs: integer({ def: 15_000, min: 1_000 }),
      // One numbered button per finding, so a ten-finding review still fits on one screen.
      maxFindingButtons: integer({ def: 8, min: 0, max: 40 }),
      rerunButton: bool({ def: true }),
      notify: bool({ def: true }),
    }),
    slack: record({
      transport: enumerated(["userToken", "botToken", "webhook"], { def: "userToken" }),
      channelEnv: string({ def: "LAIDBACK_SLACK_CHANNEL" }),
      channelName: string({ def: "laidback-reviewer-gate" }),
      allowUsersEnv: string({ def: "LAIDBACK_SLACK_USERS" }),
      tokenEnv: string({ def: "SLACK_MCP_XOXC_TOKEN" }),
      cookieEnv: string({ def: "SLACK_MCP_XOXD_TOKEN" }),
      webhookUrlEnv: string({ def: "LAIDBACK_SLACK_WEBHOOK" }),
      // One thread reply per inline comment, so the decider reads the finding rather than a line number.
      maxCommentReplies: integer({ def: 25, min: 0 }),
      timeoutMs: integer({ def: 15_000, min: 1_000 }),
      // Emoji on the gate message itself. The bot seeds these on its own post when a different
      // identity will click them. Names must exist in Slack's own set: Slack has no `pause_button`.
      reactions: record({
        approve: list(string(), { def: ["white_check_mark"] }),
        reject: list(string(), { def: ["x"] }),
        hold: list(string(), { def: ["hourglass_flowing_sand"] }),
        // A better review of the same head, asked for after the reviewer itself improved.
        rerun: list(string(), { def: ["arrows_counterclockwise"] }),
      }),
      // auto: skip seeding when the posting identity is also a possible decider, which is the case for
      // a user token, because clicking would then clear the chip rather than set it.
      seedReactions: enumerated(["auto", "always", "never"], { def: "auto" }),
      // A gate posted into your own DM is read the instant it lands. auto puts the read marker back
      // when the poster is one of the deciders, which is the only case that needs it.
      markUnread: enumerated(["auto", "always", "never"], { def: "auto" }),
      // Change only for a proxy or a test double.
      apiBaseUrl: string({ def: "https://slack.com/api" }),
    }),
  }),
});

function validate(value, schema, path, errors) {
  if (schema.kind === "record") {
    if (value === undefined) value = {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected a mapping`);
      return {};
    }
    const out = {};
    for (const [key, leaf] of Object.entries(schema.schema)) {
      out[key] = validate(value[key], leaf, path ? `${path}.${key}` : key, errors);
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema.schema)) {
        errors.push(`${path ? `${path}.` : ""}${key}: unknown key (allowed: ${Object.keys(schema.schema).join(", ")})`);
      }
    }
    return out;
  }

  if (value === undefined) {
    if (schema.required) errors.push(`${path}: required`);
    return structuredClone(schema.def ?? (schema.kind === "list" ? [] : undefined));
  }

  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") {
        errors.push(`${path}: expected a string, got ${typeof value}`);
        return schema.def ?? "";
      }
      return value;
    case "integer": {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n)) {
        errors.push(`${path}: expected an integer`);
        return schema.def ?? 0;
      }
      if (schema.min !== undefined && n < schema.min) errors.push(`${path}: must be >= ${schema.min}`);
      if (schema.max !== undefined && n > schema.max) errors.push(`${path}: must be <= ${schema.max}`);
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      errors.push(`${path}: expected true or false`);
      return schema.def ?? false;
    case "enum":
      if (!schema.values.includes(value)) {
        errors.push(`${path}: must be one of ${schema.values.join(", ")}`);
        return schema.def ?? schema.values[0];
      }
      return value;
    case "list": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected a list`);
        return [];
      }
      return value.map((entry, i) => validate(entry, schema.item, `${path}[${i}]`, errors));
    }
    default:
      errors.push(`${path}: unknown schema kind ${schema.kind}`);
      return value;
  }
}

/**
 * Exactly two keys have an environment fallback: LAIDBACK_MODEL_PROVIDER and LAIDBACK_MODEL_ID. The
 * model id belongs to the machine, the policy belongs to the file.
 */
function applyEnvDefaults(raw, env) {
  const agent = raw?.agent ?? {};
  const model = agent.model ?? {};
  const out = { ...raw, agent: { ...agent, model: { ...model }, skillsDir: agent.skillsDir ?? "" } };
  if (!out.agent.model.provider && env.LAIDBACK_MODEL_PROVIDER) out.agent.model.provider = env.LAIDBACK_MODEL_PROVIDER;
  if (!out.agent.model.id && env.LAIDBACK_MODEL_ID) out.agent.model.id = env.LAIDBACK_MODEL_ID;
  // The review agent lives wherever this machine keeps it, so the directory is environment-scoped like
  // the model, rather than a path written into a published config.
  if (raw?.agent?.agentDir === undefined && env.LAIDBACK_AGENT_DIR) out.agent.agentDir = env.LAIDBACK_AGENT_DIR;
  if (raw?.agent?.name === undefined && env.LAIDBACK_AGENT_NAME) out.agent.name = env.LAIDBACK_AGENT_NAME;
  // An empty skillsDir means "whatever the agent dir declares"; in the container that is the mounted
  // skills checkout, so the mount path belongs in the environment.
  if (!out.agent.skillsDir && env.LAIDBACK_SKILLS_DIR) out.agent.skillsDir = env.LAIDBACK_SKILLS_DIR;
  // The container binds its writable area at /work, while a host run uses a directory next to the
  // config. One variable moves all four paths together, so a relative path in the file cannot resolve
  // onto a read-only rootfs.
  if (env.LAIDBACK_WORK_DIR) {
    const work = env.LAIDBACK_WORK_DIR;
    const checkout = { ...(raw?.checkout ?? {}) };
    const toolchain = { ...(raw?.toolchain ?? {}) };
    out.checkout = {
      ...checkout,
      root: checkout.root ?? `${work}/repos`,
      scratch: checkout.scratch ?? `${work}/scratch`,
      compareDir: checkout.compareDir ?? `${work}/scratch/refs`,
      gitConfig: checkout.gitConfig ?? `${work}/gitconfig`,
    };
    out.toolchain = { ...toolchain, installDir: toolchain.installDir ?? `${work}/tools` };
  }
  if (env.LAIDBACK_GOPROXY && !out.checkout?.goProxy) out.checkout = { ...(out.checkout ?? {}), goProxy: env.LAIDBACK_GOPROXY };
  return out;
}

/** `~` and `~/x` against HOME; anything else is returned untouched. */
export function expandHome(value, env = {}) {
  const raw = String(value ?? "");
  if (raw !== "~" && !raw.startsWith("~/")) return raw;
  const home = env.HOME || process.env.HOME || "";
  if (!home) return raw;
  return raw === "~" ? home : nodePath.join(home, raw.slice(2));
}

export function loadConfig({ path = process.env.LAIDBACK_CONFIG || "config.yaml", env = process.env } = {}) {
  if (!fs.existsSync(path)) {
    throw new Error(`config not found: ${path} (copy config.example.yaml to config.yaml)`);
  }
  const raw = parseYaml(fs.readFileSync(path, "utf8")) ?? {};
  const errors = [];
  const cfg = validate(applyEnvDefaults(raw, env), CONFIG_SCHEMA, "", errors);
  if (errors.length) {
    let hint = "";
    if (errors.some((error) => /agent\.model\.(provider|id): required/.test(error))) {
      hint = "\n  (agent.model.provider and agent.model.id may also come from LAIDBACK_MODEL_PROVIDER and LAIDBACK_MODEL_ID)";
    }
    if (errors.some((error) => /includeReviewRequests/.test(error))) {
      hint += "\n  (a review request is the trigger now: use trigger.mode: review_requested or both, and trigger.assigned for assignments)";
    }
    throw new Error(`invalid config (${path}):\n  - ${errors.join("\n  - ")}${hint}`);
  }
  cfg._deprecations = [...applyTriggerAliases(raw, cfg), ...applyReviewAliases(raw, cfg), ...applyBannerAliases(raw, cfg)];
  cfg.agent.agentDir = expandHome(cfg.agent.agentDir, env);
  cfg.agent.skillsDir = expandHome(cfg.agent.skillsDir, env);
  cfg._path = path;
  cfg._env = env;
  return cfg;
}

/** `reviews.rereviewOnPush` is gone: re-review follows the request, not a flag that only skipped the seen table. */
function applyReviewAliases(raw, cfg) {
  const legacy = raw.reviews?.rereviewOnPush;
  if (legacy === undefined) return [];
  if (raw.reviews?.respondToReRequest === undefined) cfg.reviews.respondToReRequest = true;
  return ["reviews.rereviewOnPush is gone; a moved head is a new key and is reviewed again anyway, so reviews.respondToReRequest now covers a re-request on the same head (maxReReviewsPerHead caps it)"];
}

/** `banner.rephrase` is split per slot: a footer that must not be reworded can now be left alone. */
function applyBannerAliases(raw, cfg) {
  const legacy = raw.banner?.rephrase;
  if (legacy === undefined) return [];
  if (raw.banner?.rephrasePrefix === undefined) cfg.banner.rephrasePrefix = Boolean(legacy);
  if (raw.banner?.rephraseSuffix === undefined) cfg.banner.rephraseSuffix = Boolean(legacy);
  return ["banner.rephrase is now banner.rephrasePrefix and banner.rephraseSuffix, so a fixed suffix can stay verbatim"]; 
}

/** `assignment:` was renamed to `trigger:`; old files still load, with a startup note. */
function applyTriggerAliases(raw, cfg) {
  const legacy = raw.assignment;
  if (!legacy || typeof legacy !== "object") return [];
  const notes = [];
  if (legacy.policy !== undefined && raw.trigger?.policy === undefined) cfg.trigger.policy = legacy.policy;
  if (legacy.skipDraft !== undefined && raw.trigger?.skipDraft === undefined) cfg.trigger.skipDraft = legacy.skipDraft;
  notes.push("assignment: is now trigger: (mode, policy, skipDraft); the mode defaults to review_requested, so assignments alone no longer start a review");
  return notes;
}

/** Secrets live in the environment; the config file only names the variable. */
export function secret(cfg, varName, { required = false } = {}) {
  const value = (cfg._env ?? process.env)[varName];
  if (!value && required) throw new Error(`missing environment variable ${varName} (referenced by ${cfg._path})`);
  return value || "";
}
