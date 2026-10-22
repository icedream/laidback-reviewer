/**
 * The gate channel in use.
 *
 * The transports share one interface, post / readDecisions / expire, so the loop and the command line do
 * not need to know which messaging system is configured.
 */

import { slackGateFromConfig } from "./slack.mjs";
import { telegramGateFromConfig } from "./telegram.mjs";

export function gateTransportFromConfig({ cfg, store, env = process.env, log = () => {} }) {
  if (cfg.gate.channel === "telegram") return telegramGateFromConfig({ cfg, store, env, log });
  if (cfg.gate.channel === "slack") return slackGateFromConfig({ cfg, store, env, log });
  return null;
}
