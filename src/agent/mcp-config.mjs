/**
 * The MCP servers a review session may connect to, read from one file.
 *
 * pi reads `<agentDir>/mcp.json` and, for a trusted project, `<cwd>/.pi/mcp.json`, where a project entry
 * replaces a user-level entry of the same name. A review session's cwd is a worktree of the repository
 * under review, so that second file would let the reviewed repository define `atlassian` itself and point
 * the session at an address its author chose, or run a command in the container. The tool allowlist cannot
 * catch it: the impostor's tools carry exactly the names the allowlist permits.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/** `${NAME}` from the environment, or a whole value that is `!command`, as pi's own loader does. */
function expandValue(value, env) {
  if (typeof value !== "string") return value;
  if (value.startsWith("!")) return execSync(value.slice(1), { encoding: "utf8", env }).trim();
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name) => (env[name] === undefined ? whole : env[name]));
}

function expandMap(map, env) {
  if (!map || typeof map !== "object") return map;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, expandValue(value, env)]));
}

/**
 * Returns the shape pi's MCP extension expects: entries with the config file that defined them. Unknown
 * or broken entries are reported rather than dropped in silence, and a missing file is simply no servers.
 */
export function loadAgentMcpConfig(agentDir, { env = process.env } = {}) {
  const file = path.join(agentDir, "mcp.json");
  const errors = [];
  const servers = [];
  if (!fs.existsSync(file)) return { servers, errors };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { servers, errors: [`${file}: ${error.message}`] };
  }

  for (const [name, raw] of Object.entries(parsed?.mcpServers ?? {})) {
    if (!raw || typeof raw !== "object") {
      errors.push(`${file}: server "${name}" is not an object`);
      continue;
    }
    if (!raw.url && !raw.command) {
      errors.push(`${file}: server "${name}" needs url or command`);
      continue;
    }
    try {
      const config = { ...raw };
      if (config.headers) config.headers = expandMap(config.headers, env);
      if (config.env) config.env = expandMap(config.env, env);
      servers.push({ name, config, source: file, scope: "global" });
    } catch (error) {
      errors.push(`${file}: server "${name}": ${error.message}`);
    }
  }
  return { servers, errors };
}
