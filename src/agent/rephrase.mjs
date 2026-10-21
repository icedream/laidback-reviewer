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

const PROMPT = (prefix, suffix, prRef) => [
  "Rewrite two banner lines for a pull-request review. Keep every claim, add none.",
  "Rules: at most two lines each, no verdict or merge words unless present below, no links, no",
  `mentions, no new markup. Output exactly two lines, first the prefix, then the suffix.${prRef ? ` PR for context: ${prRef}` : ""}`,
  "",
  `prefix: ${prefix || "(none: output SKIP)"}`,
  `suffix: ${suffix || "(none: output SKIP)"}`,
].join("\n");

/** Split a model answer back into the two slots and validate each against its source. */
export function parseRephrasedBanners(raw, { prefix, suffix }) {
  const lines = String(raw ?? "")
    .trim()
    .split("\n")
    .map((line) => line.replace(/^(prefix|suffix):\s*/i, "").trim())
    .filter((line) => line && line.toUpperCase() !== "SKIP");

  const out = { notes: [] };
  const slots = [
    ["prefix", prefix],
    ["suffix", suffix],
  ];
  for (const [index, [name, source]] of slots.entries()) {
    if (!source) continue;
    const candidate = lines[index] ?? "";
    const check = validateBannerSlot(source, candidate, { label: `banner.${name}` });
    out[name] = check.ok ? candidate : source;
    if (!check.ok) out.notes.push(check.reason);
  }
  if (!out.notes.length) delete out.notes;
  return out;
}

export async function rephraseBanner({ cfg, agentDir, cwd, prRef, log = () => {} }) {
  const { prefix, suffix } = cfg.banner;
  if (!cfg.banner.rephrase || (!prefix && !suffix)) return null;

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
    await session.prompt(PROMPT(prefix, suffix, prRef));
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    const text = Array.isArray(last?.content)
      ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : last?.content ?? "";
    const parsed = parseRephrasedBanners(text, { prefix, suffix });
    if (parsed.notes) log(`banner rephrase rejected: ${parsed.notes.join("; ")}; using the configured text`);
    return { prefix: parsed.prefix ?? prefix, suffix: parsed.suffix ?? suffix };
  } finally {
    session.dispose();
  }
}
