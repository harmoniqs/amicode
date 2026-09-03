// ============================================================================
// amicode_context — an opencode plugin that injects live stack-state context
// (solver mode, routing, active problem, live runs, recent sessions) into
// every system prompt via the `experimental.chat.system.transform` hook.
//
// RUNTIME: same constraints as amicode_tools.ts — executes inside opencode's
// embedded Bun runtime, registered by absolute path via OPENCODE_CONFIG_CONTENT
// `plugin: ["<abs>"]`. Exactly ONE export (the legacy-plugin scan constraint).
// All imports are sibling modules using node:/bun: builtins only.
//
// This is a SECOND plugin file alongside amicode_tools.ts; it is registered as
// a separate entry in the `plugin` array and operates independently from the
// tool pack. The split keeps the tested tool pack untouched and respects the
// single-export constraint.
// ============================================================================

import { buildStackStateBlock } from "./stack_state";
import { buildRecentSessionsBlock } from "./session_recap";
import { buildSetupStateSection } from "./setup_state";

console.error("[amicode-context] loaded — stack-state + session-recap injection plugin");

export const AmicodeContext = async () => ({
  "experimental.chat.system.transform": async (
    input: { sessionID?: string; model?: string },
    output: { system: string[] },
  ): Promise<void> => {
    // Stack state (solver mode, active problem, runs, fleet, vault)
    try {
      const block = buildStackStateBlock();
      if (block) {
        output.system.push(block);
      }
    } catch (e) {
      console.error(`[amicode-context] buildStackStateBlock failed: ${e instanceof Error ? e.message : String(e)}`);
      // Never throw — a failing hook must not break the prompt build.
    }

    // Setup state (agent-driven tool setup — only when something needs attention)
    try {
      const setup = buildSetupStateSection();
      if (setup) {
        output.system.push(setup);
      }
    } catch (e) {
      console.error(`[amicode-context] buildSetupStateSection failed: ${e instanceof Error ? e.message : String(e)}`);
      // Never throw — a missing section is silent, a crash is not.
    }

    // Recent sessions recap (from the opencode session DB)
    try {
      const recapBlock = buildRecentSessionsBlock(input.sessionID);
      if (recapBlock) {
        output.system.push(recapBlock);
      }
    } catch (e) {
      console.error(`[amicode-context] buildRecentSessionsBlock failed: ${e instanceof Error ? e.message : String(e)}`);
      // Never throw — graceful degradation: no recap is better than a crash.
    }
  },
});
