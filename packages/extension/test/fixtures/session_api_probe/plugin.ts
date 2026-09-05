// ============================================================================
// session_api_probe/plugin.ts — the H4 session-API AVAILABILITY FIXTURE's
// in-server probe (#808, spec-20260905-063000 D4). This is NOT product code and
// never ships in the vsix: it is registered by the availability fixture test
// (test/mode_block.test.ts, describe "H4 FIRST") through OPENCODE_CONFIG_CONTENT
// so it loads inside the REAL vendored opencode binary's Bun runtime — exactly
// the load path amicode_context.ts uses in production (same `plugin` array,
// same loader, same PluginInput).
//
// What it proves (the fixture's four facts, recorded to a JSONL file via
// $AMICO_SESSION_API_PROBE_OUT):
//   1. the plugin FACTORY input carries a server-bound engine client
//      (input.client — the same handoff amicode_tools.ts relies on);
//   2. the `experimental.chat.system.transform` hook fires per LLM request
//      with { sessionID, model } (the hook input contract);
//   3. INSIDE the transform hook, the captured client's
//      `session.get({ path: { id }, query: { directory } })` round-trips;
//   4. the returned Session.Info carries the session's `agent` — the value the
//      session was created/promted with (here: "autodev", the fixture's
//      config-declared director agent).
//
// If any leg fails, the fixture records the named failure — the D4 contingency
// (spec: NO widening executes; fallback-only with the unresolvable semantics
// preserved) is decided on THIS record, never on a guess.
//
// Runtime contract: same as the product plugins — node builtins only, exactly
// one export, never throws from the hook.
// ============================================================================

import * as fs from "node:fs";

type ProbeRecord =
  | { event: "factory"; has_client: boolean; has_get: boolean; has_directory: boolean }
  | { event: "transform"; sessionID: string | null; has_model: boolean }
  | {
      event: "resolve";
      ok: boolean;
      via: "session.get";
      sessionID: string | null;
      agent: string | null;
      reason?: string;
    };

export const SessionApiProbe = async (input: unknown) => {
  const outPath = process.env.AMICO_SESSION_API_PROBE_OUT;
  const directory = (input as { directory?: unknown } | undefined)?.directory;
  const client = (input as { client?: unknown } | undefined)?.client as
    | { session: { get: (o: unknown) => Promise<unknown> } }
    | undefined;

  const write = (rec: ProbeRecord): void => {
    if (outPath === undefined || outPath === "") return;
    try {
      fs.appendFileSync(outPath, JSON.stringify(rec) + "\n");
    } catch {
      // a failing probe write must never break the server
    }
  };

  write({
    event: "factory",
    has_client: typeof client === "object" && client !== null,
    has_get: typeof client?.session?.get === "function",
    has_directory: typeof directory === "string",
  });

  return {
    "experimental.chat.system.transform": async (
      hookInput: { sessionID?: string; model?: unknown },
      _output: { system: string[] },
    ): Promise<void> => {
      const sessionID = typeof hookInput.sessionID === "string" ? hookInput.sessionID : null;
      write({ event: "transform", sessionID, has_model: hookInput.model !== undefined });
      if (client === undefined || typeof client.session.get !== "function" || sessionID === null) {
        write({ event: "resolve", ok: false, via: "session.get", sessionID, agent: null, reason: "no client or no sessionID inside the transform hook" });
        return;
      }
      try {
        const res = await client.session.get({
          path: { id: sessionID },
          query: typeof directory === "string" ? { directory } : undefined,
        });
        // hey-api clients return {data?, error?} when not throwing; older call
        // shapes return the payload directly. One defensive unwrap (the same
        // idiom as session_spawn.ts's unwrap).
        const info = (
          res && typeof res === "object" && "data" in (res as Record<string, unknown>)
            ? (res as { data?: unknown }).data
            : res
        ) as { agent?: unknown } | undefined | null;
        const agent = typeof info?.agent === "string" ? info.agent : null;
        write({
          event: "resolve",
          ok: agent !== null,
          via: "session.get",
          sessionID,
          agent,
          ...(agent === null ? { reason: "session.get returned but Session.Info.agent is absent/null" } : {}),
        });
      } catch (e) {
        write({ event: "resolve", ok: false, via: "session.get", sessionID, agent: null, reason: `session.get threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
  };
};
