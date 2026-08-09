// ============================================================================
// amicode_context — an opencode plugin that injects live stack-state context
// (solver mode, routing, active problem, live runs) into every system prompt
// via the `experimental.chat.system.transform` hook.
//
// RUNTIME: same constraints as amicode_tools.ts — executes inside opencode's
// embedded Bun runtime, registered by absolute path via OPENCODE_CONFIG_CONTENT
// `plugin: ["<abs>"]`. Exactly ONE export (the legacy-plugin scan constraint).
// All imports are sibling modules using node: builtins only.
//
// This is a SECOND plugin file alongside amicode_tools.ts; it is registered as
// a separate entry in the `plugin` array and operates independently from the
// tool pack. The split keeps the tested tool pack untouched and respects the
// single-export constraint.
// ============================================================================

import { buildStackStateBlock } from "./stack_state";

console.error("[amicode-context] loaded — stack-state injection plugin (experimental.chat.system.transform)");

export const AmicodeContext = async () => ({
  "experimental.chat.system.transform": (
    _input: { sessionID?: string; model?: string },
    output: { system: string[] },
  ): void => {
    try {
      const block = buildStackStateBlock();
      if (block) {
        output.system.push(block);
      }
    } catch (e) {
      console.error(`[amicode-context] buildStackStateBlock failed: ${e instanceof Error ? e.message : String(e)}`);
      // Never throw — a failing hook must not break the prompt build.
    }
  },
});
