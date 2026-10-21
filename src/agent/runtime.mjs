/**
 * Session wiring.
 *
 * A review session gets: the agent file as its system prompt, the proposal tools, the tool policy,
 * a positive tool allowlist, and one session per review so transcripts never bleed into each other.
 * No posting tool exists here.
 */

import {
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createMcpExtension,
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";

function systemPromptExtension(prompt) {
  return (pi) => {
    pi.on("before_agent_start", async (event) => ({ systemPrompt: prompt ?? event.systemPrompt }));
  };
}

/**
 * The skills the agent file assumes are present. Replacing the system prompt drops the skills
 * section pi normally renders, and pr-review says "cite them, do not restate them", so the listing
 * has to come back with it.
 */
function skillPromptBlock({ agentDir, cwd, skillsDir }) {
  const dirs = [path.join(agentDir, "skills"), path.join(cwd, ".pi", "skills"), skillsDir].filter(Boolean);
  const byName = new Map();
  for (const dir of dirs) {
    for (const skill of loadSkillsFromDir({ dir, source: "config" }).skills) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return byName.size ? formatSkillsForPrompt([...byName.values()]) : "";
}

/**
 * @param agentDef parsed agents/<name>.md; its body replaces the default prompt unless promptMode is
 *                 "append"
 * @param contract runtime contract appended to whatever prompt is used
 * @param tools    positive allowlist; anything absent from it is not callable
 */
export async function createReviewSession({ cfg, agentDir, cwd, agentDef, contract, extensionFactories, customTools, sessionManager, tools }) {
  const agentPrompt = [
    agentDef.promptMode === "append" ? null : agentDef.body,
    contract,
    skillPromptBlock({ agentDir, cwd, skillsDir: cfg.agent.skillsDir }),
  ]
    .filter(Boolean)
    .join("\n\n");

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  // An SDK session does not load MCP on its own; the servers in the agent dir's mcp.json need this
  // factory. Their read-only enforcement lives in the guard, whatever the credential allows.
  const factories = cfg.tools.mcp.length ? [...extensionFactories, createMcpExtension({})] : [...extensionFactories];
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [systemPromptExtension(agentDef.promptMode === "append" ? null : agentPrompt), ...factories],
    },
  });

  const model = services.modelRuntime.getModel(cfg.agent.model.provider, cfg.agent.model.id);
  if (!model) {
    const available = (services.modelRuntime.getModels() ?? [])
      .slice(0, 30)
      .map((entry) => `${entry.provider}/${entry.id}`)
      .join(", ");
    throw new Error(
      `model ${cfg.agent.model.provider}/${cfg.agent.model.id} is not available.\n  configured: ${available || "(none)"}\n  check agent.model in config.yaml and models.json in the agent dir`,
    );
  }

  // An explicit allowlist replaces the default set, and custom tools are not part of it: without
  // this the proposal tools would be registered but never declared to the model.
  const mcpAllowlist = cfg.tools.mcp.map((server) => `mcp__${server}__*`);
  const toolAllowlist = [...tools, ...customTools.map((tool) => tool.name), ...mcpAllowlist];

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: cfg.agent.model.thinking,
    tools: toolAllowlist,
    customTools,
  });

  // The SDK path does not emit session_start on its own, so extensions (MCP included) stay
  // uninitialized unless bindExtensions runs first.
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      console.error(`  extension error (${error.extensionPath}): ${error.error}`);
    },
  });

  return { session, services, model };
}

export const REVIEW_TOOLS = (cfg) => ["read", "grep", "find", "ls", ...(cfg.tools.bash ? ["bash"] : [])];
