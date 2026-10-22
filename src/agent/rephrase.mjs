/**
 * Banner rephrasing.
 *
 * One small model call whose only job is to make a configured banner read naturally in the context of
 * one PR. Its output is checked against the configured text: the rewrite may change wording, not
 * claims. Anything that fails the check falls back to the literal configured strings, so a model that
 * embellishes cannot turn a notice into an approval.
 */

import { SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { validateBannerSlot } from "../proposal/policy.mjs";

/** Asks only for the slots that actually need a rewrite, so a fixed footer is never offered. */
const PROMPT = (slots, prRef) => [
  "Rewrite banner lines for a pull-request review. Keep every claim, add none.",
  "Rules: at most two lines each, no verdict or merge words unless present below, no links, no",
  "mentions, no new markup. Output one line per banner, each starting with its name.",
  ...Object.entries(slots).map(([name, text]) => `${name}: ${text}`),
  prRef ? `PR for context: ${prRef}` : "",
]
  .filter(Boolean)
  .join("\n");

/** Split a model answer into the requested slots, labelled first and positional as a fallback. */
export function parseRephrasedBanners(raw, slots) {
  const lines = String(raw ?? "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.toUpperCase() !== "SKIP");

  const out = { notes: [] };
  const labelled = new Map();
  const bare = [];
  for (const line of lines) {
    const match = /^(prefix|suffix):\s*(.*)$/i.exec(line);
    if (match) labelled.set(match[1].toLowerCase(), match[2].trim());
    else bare.push(line);
  }

  Object.keys(slots)
    .filter((name) => String(slots[name] ?? "").trim())
    .forEach((name, index) => {
    const source = slots[name];
    const candidate = labelled.get(name) ?? bare[index] ?? "";
    const check = validateBannerSlot(source, candidate, { label: `banner.${name}` });
    out[name] = check.ok ? candidate : source;
    if (!check.ok) out.notes.push(check.reason);
  });

  if (!out.notes.length) delete out.notes;
  return out;
}

/**
 * @param slots the banner slots that need wording, typically the ones the review did not carry itself
 * @returns {{ prefix: string, suffix: string }} with unchanged text where a rewrite was refused
 */
export async function rephraseBanner({ cfg, agentDir, cwd, prRef, slots, log = () => {} }) {
  const wanted = Object.fromEntries(Object.entries(slots ?? {}).filter(([, text]) => String(text ?? "").trim()));
  if (!Object.keys(wanted).length) return null;

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
  const model = services.modelRuntime.getModel(cfg.agent.model.provider, cfg.agent.model.id);
  if (!model) throw new Error(`model ${cfg.agent.model.provider}/${cfg.agent.model.id} is not available for banner rephrasing`);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
    thinkingLevel: "low",
    noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });

  try {
    await session.prompt(PROMPT(wanted, prRef));
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    const text = Array.isArray(last?.content)
      ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : last?.content ?? "";
    const parsed = parseRephrasedBanners(text, wanted);
    if (parsed.notes) log(`banner rephrase rejected: ${parsed.notes.join("; ")}; using the configured text`);
    return Object.fromEntries(Object.keys(wanted).map((name) => [name, parsed[name] ?? wanted[name]]));
  } finally {
    session.dispose();
  }
}
