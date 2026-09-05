// ============================================================================
// amicode_context — an opencode plugin that injects live stack-state context
// (solver mode, routing, active problem, live runs, recent sessions) plus the
// posture-aware `## Active mode` block (#808, spec D4) into every system
// prompt via the `experimental.chat.system.transform` hook.
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
//
// #808: the plugin FACTORY input carries the server-bound engine client (the
// same PluginInput handoff amicode_tools.ts relies on — proven live by the
// session-API availability fixture in test/mode_block.test.ts, H4 FIRST),
// plus the session's `directory`. Both are closed over and handed to
// buildModeBlock per request; the mode block is emitted FIRST (posture is the
// most load-bearing context a director session carries).
// ============================================================================

import { buildModeBlock, deployedModesRoot, type ModeBlockClient } from "./mode_block";
import { buildStackStateBlock } from "./stack_state";
import { buildRecentSessionsBlock } from "./session_recap";
import { buildSetupStateSection } from "./setup_state";

console.error("[amicode-context] loaded — stack-state + session-recap + mode-block injection plugin");

export const AmicodeContext = async (input: unknown) => {
  // The engine client the loader hands the plugin (createOpencodeClient-bound
  // to this server) — the session-API availability fixture proved the
  // transform-hook resolution path over exactly this handoff. The structural
  // type is the subset mode_block uses (session.get + session.messages).
  const engineClient = (input as { client?: unknown } | undefined)?.client as ModeBlockClient | undefined;
  const directory = (input as { directory?: unknown } | undefined)?.directory;
  const clientOrNull = engineClient !== undefined && engineClient !== null ? engineClient : null;

  return {
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: string },
      output: { system: string[] },
    ): Promise<void> => {
      // The Active mode block (#808, D4) — FIRST: posture before state. Named
      // outcomes only; null (copilot / pre-registry / no sessionID) is silent.
      try {
        const block = await buildModeBlock({
          sessionID: typeof input.sessionID === "string" ? input.sessionID : null,
          engineClient: clientOrNull,
          registryRoot: deployedModesRoot(),
          directory: typeof directory === "string" ? directory : null,
        });
        if (block) {
          output.system.push(block);
        }
      } catch (e) {
        console.error(`[amicode-context] buildModeBlock failed: ${e instanceof Error ? e.message : String(e)}`);
        // Never throw — a failing hook must not break the prompt build.
      }

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
  };
};
