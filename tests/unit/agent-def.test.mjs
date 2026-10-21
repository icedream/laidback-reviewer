/** The failure an operator hits first: no review agent file where the config points. */

import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentDef } from "../../src/agent/agent-def.mjs";

test("a missing agent file names the path and both ways to point elsewhere", () => {
  assert.throws(() => loadAgentDef("/nowhere/agents", "pr-review"), /review agent not found: \/nowhere\/agents\/pr-review\.md/);
  assert.throws(() => loadAgentDef("/nowhere/agents", "pr-review"), /LAIDBACK_AGENT_DIR/);
});
