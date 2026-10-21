/**
 * Configuration loading.
 *
 * Fail-closed: an unknown key is an error rather than a ignored typo, because a
 * silently dropped key could be a permission narrowing (an allowlist, a policy mode).
 */

import fs from "node:fs";
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
    probeRepo: string({ def: "" }),
    pollIntervalMs: integer({ def: 120_000, min: 15_000 }),
    searchAgeHours: integer({ def: 24, min: 1 }),
  }),
  assignment: record({
    policy: enumerated(["any", "human_actor", "exclude_codeowners"], { def: "any" }),
    includeReviewRequests: bool({ def: false }),
    skipDraft: bool({ def: true }),
  }),
  reviews: record({
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
    // Failures are recorded per (pr, head): the next attempt waits, and a head that keeps failing is
    // parked.
    maxAttemptsPerHead: integer({ def: 4, min: 1 }),
    retryBaseMs: integer({ def: 120_000, min: 1_000 }),
    retryMaxMs: integer({ def: 21_600_000, min: 1_000 }),
  }),
  banner: record({
    prefix: string({ def: "" }),
    suffix: string({ def: "" }),
    rephrase: bool({ def: false }),
  }),
  agent: record({
    name: string({ def: "pr-review" }),
    agentDir: string({ def: ".pi/agent/agents" }),
    skillsDir: string({ def: "" }),
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
        preferRepoVersion: bool({ def: true }),
  }),
  context: record({
    enabled: bool({ def: true }),
    maxAgeDays: integer({ def: 30, min: 1 }),
    minScore: integer({ def: 35, min: 0, max: 100 }),
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
  }),
  tools: record({
    bash: bool({ def: true }),
    mcp: list(string(), { def: [] }),
    allowHosts: list(string(), {
      def: ["github.com", "api.github.com", "raw.githubusercontent.com", "mcp.atlassian.com"],
    }),
  }),
  gate: record({
    channel: enumerated(["slack", "cli", "none"], { def: "cli" }),
    beforeReview: bool({ def: false }),
    beforePost: bool({ def: true }),
    timeoutHours: integer({ def: 24, min: 1 }),
    onTimeout: enumerated(["hold", "skip"], { def: "hold" }),
    maxPending: integer({ def: 5, min: 1 }),
    slack: record({
      transport: enumerated(["userToken", "botToken", "webhook"], { def: "userToken" }),
      channelEnv: string({ def: "LAIDBACK_SLACK_CHANNEL" }),
      channelName: string({ def: "laidback-reviewer-gate" }),
      allowUsersEnv: string({ def: "LAIDBACK_SLACK_USERS" }),
      tokenEnv: string({ def: "SLACK_MCP_XOXC_TOKEN" }),
      cookieEnv: string({ def: "SLACK_MCP_XOXD_TOKEN" }),
      webhookUrlEnv: string({ def: "LAIDBACK_SLACK_WEBHOOK" }),
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

export function loadConfig({ path = process.env.LAIDBACK_CONFIG || "config.yaml", env = process.env } = {}) {
  if (!fs.existsSync(path)) {
    throw new Error(`config not found: ${path} (copy config.example.yaml to config.yaml)`);
  }
  const raw = parseYaml(fs.readFileSync(path, "utf8")) ?? {};
  const errors = [];
  const cfg = validate(raw, CONFIG_SCHEMA, "", errors);
  if (errors.length) throw new Error(`invalid config (${path}):\n  - ${errors.join("\n  - ")}`);
  cfg._path = path;
  cfg._env = env;
  return cfg;
}

/** Secrets live in the environment; the config file only names the variable. */
export function secret(cfg, varName, { required = false } = {}) {
  const value = (cfg._env ?? process.env)[varName];
  if (!value && required) throw new Error(`missing environment variable ${varName} (referenced by ${cfg._path})`);
  return value || "";
}
