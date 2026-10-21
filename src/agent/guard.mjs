/**
 * Tool policy for a review run.
 *
 * This is intent enforcement, not a boundary: bash commands are pattern-matched. The layers that hold
 * are the credential scope (Pull requests: read and write, Contents: read-only) and the absence of a
 * posting tool. What this layer buys is that ordinary mistakes and the first deliberate attempt fail
 * loudly and land in `blocked`.
 */

// Deny patterns are matched against the command positions, not against arbitrary text: a review that
// quotes `go mod tidy` in a note, or greps a path containing `docker`, is not running either thing.
const BASH_DENY = [
  { re: /\bgit\b[^|;&]*\bpush\b/, reason: "git push is not permitted: a review bot has no write access to repository contents" },
  { re: /\bgit\s+config\b.*(credential|url\.|remote\.|insteadOf)/, reason: "git config for credentials, URL rewriting, or remotes is not permitted" },
  // merge-base and merge-tree are read-only lookups; plain `git merge` is not.
  { re: /\bgit\b[^|;&]*\b(commit|merge(?!-)|rebase|reset\s+--hard|checkout\s+-b|switch\s+-c|tag)\b/, reason: "git history changes are not permitted" },
  { re: /\bgh\s+pr\s+(merge|close|review|ready|rebase|comment)\b/, reason: "gh pr writes are not permitted; reviews go through the harness" },
  { re: /\bgh\s+(repo|release|workflow|run|secret|auth(?!\s+status)\b|extension)\b/, reason: "this gh subcommand is not permitted" },
  { re: /\bgh\s+api\b[^|;&]*(--input|-X\s*(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE))/, reason: "gh api writes are not permitted" },
  { re: /(^|[|;&(]\s*)(sudo\s+)?(kubectl|helm|docker|podman|terraform|ansible|ssh|scp)\s/, reason: "deploy and remote-access tools are not available to a review run" },
  { re: /(^|[|;&(]\s*)(npm\s+publish|go\s+mod\s+(tidy|vendor)|pip\s+install|apt(-get)?\s+install)\b/, reason: "supply-chain and package-manager writes are not permitted" },
  { re: /\brm\s+-rf\b(?![^|;]*\/tmp)/, reason: "recursive delete is limited to /tmp" },
];

// Notes and scratch records often quote the commands they are talking about, so a heredoc body is not
// a command.
function stripHeredocs(command) {
  return String(command)
    .replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[\s\S]*?\n\s*\1\b/g, "<<removed")
    .replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*$/g, "<<removed");
}

const MANIFEST_FILES = /\b(go\.(mod|sum|work)(\.tmp)?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^\s]*\.txt|Pipfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock)\b/g;

/**
 * A manifest being written, as opposed to being read: redirects, tee, and a copy or move whose
 * destination is a manifest. Writing a note about manifests under the scratch root is allowed.
 */
function manifestWriteDenied(command) {
  const writes = [...command.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*([^|;&\s]+)/g), ...command.matchAll(/\b(?:cp|mv|rsync)\b[^|;&]*?\s([^|;&\s]+)\s*$/gm)];
  return writes.some((match) => MANIFEST_FILES.test(match[1].trim()));
}

const READ_DENY = [
  { re: /(^|\/)\.pi\/agent\/auth\.json$/, reason: "model credentials are not readable by a review run" },
  { re: /(^|\/)\.pi\/agent\/models\.json$/, reason: "provider credentials are not readable by a review run" },
  { re: /(^|\/)\.env$/, reason: "the environment file is not readable by a review run" },
  { re: /\.pem$|\.key$|id_ed25519|id_rsa/, reason: "private keys are not readable by a review run" },
  { re: /(^|\/)(state|reviews)\.db/, reason: "bot state is not readable by a review run" },
  { re: /(^|\/)\.git\/config$/, reason: "credential helper configuration is not readable by a review run" },
];

const ATLASSIAN_READ = /^(get|search|query|list|read|fetch)/i;

function hostAllowDenied(command, allowHosts) {
  const hosts = new Set((allowHosts ?? []).map((host) => host.toLowerCase()));
  const targets = [...command.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase());
  const forbidden = targets.filter((host) => !hosts.has(host));
  return forbidden.length ? `outbound fetch to ${forbidden.join(", ")} is not in tools.allowHosts` : "";
}

function atlassianToolName(toolName, input) {
  if (toolName === "mcp") {
    const target = String(input.tool ?? "");
    const server = String(input.server ?? "");
    if (server === "atlassian" || /^atlassian_/i.test(target)) return target;
    return "";
  }
  if (/^mcp__atlassian__/i.test(toolName)) return toolName.split("__").pop();
  return "";
}

export function createReviewGuard({ allowHosts = [], bashEnabled = true, writableRoots = [], log = [] } = {}) {
  const block = (record) => {
    log.push(record);
    return { block: true, reason: record.reason };
  };

  const extension = (pi) => {
    pi.on("tool_call", async (event) => {
      const input = event.input ?? {};

      if (event.toolName === "bash") {
        if (!bashEnabled) return block({ tool: "bash", reason: "bash is disabled by configuration" });
        const command = String(input.command ?? "");
        // A heredoc body is text the command carries, not commands it runs: a review note that quotes
        // `go mod tidy` must not read as running it.
        const runnable = stripHeredocs(command);
        for (const rule of BASH_DENY) {
          if (rule.re.test(runnable)) return block({ tool: "bash", command, reason: rule.reason });
        }
        if (manifestWriteDenied(runnable)) {
          return block({ tool: "bash", command, reason: "writing a dependency manifest is not permitted; propose the change instead" });
        }
        if (/\b(curl|wget)\b/.test(command)) {
          const reason = hostAllowDenied(command, allowHosts);
          if (reason) return block({ tool: "bash", command, reason });
        }
        if (writableRoots.length) {
          const escaped = command.match(/(?:^|[\s;|&])(?:>\s*|>>\s*|tee\s+(?:-a\s+)?)(\/[^\s"']+)/g) ?? [];
          for (const entry of escaped) {
            const target = entry.replace(/.*?(?:>\s*|>>\s*|tee\s+(?:-a\s+)?)/, "");
            const inside = writableRoots.some((root) => target.startsWith(root));
            if (/^(\/app|\/work|\/data|\/home)/.test(target) && !inside) {
              return block({ tool: "bash", command, reason: `writing ${target} is outside the writable roots` });
            }
          }
        }
        return undefined;
      }

      if (event.toolName === "read") {
        const filePath = String(input.path ?? "");
        for (const rule of READ_DENY) {
          if (rule.re.test(filePath)) return block({ tool: "read", path: filePath, reason: rule.reason });
        }
        return undefined;
      }

      if (event.toolName === "mcp" || /^mcp__/.test(event.toolName)) {
        if (event.toolName === "mcp") {
          const action = String(input.action ?? "");
          if (["install", "auth-start", "auth-complete"].includes(action) || input.url) {
            return block({ tool: "mcp", reason: "a review run cannot add MCP servers or drive OAuth" });
          }
        }
        const atlassian = atlassianToolName(event.toolName, input);
        if (atlassian && !ATLASSIAN_READ.test(atlassian)) {
          return block({ tool: event.toolName, reason: `Atlassian access is read-only; '${atlassian}' is not permitted` });
        }
        return undefined;
      }

      if (["edit", "write", "notebookEdit"].includes(event.toolName)) {
        return block({ tool: event.toolName, reason: "file writes are not available in a review run" });
      }

      return undefined;
    });
  };

  return { extension, log };
}
