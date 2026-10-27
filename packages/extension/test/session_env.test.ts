// #1928 (A15): the engine exposes a session's id to tool children ONLY through
// the `shell.env` plugin hook (shell.ts / session/prompt.ts trigger it with
// {cwd, sessionID, callID}); it never lands in process.env. This hook is the
// plumbing that puts AMICO_SESSION_ID into every bash-tool env, so an agent
// token mint binds `principal.session`, and `amico review post-check` can see
// it was invoked from inside a session.
import { describe, expect, it } from "vitest";
import { applySessionEnv } from "../opencode-plugin/session_env";

describe("shell.env → AMICO_SESSION_ID", () => {
  it("sets AMICO_SESSION_ID from the hook's sessionID", () => {
    const output = { env: {} as Record<string, string> };
    applySessionEnv({ cwd: "/w", sessionID: "ses_abc123", callID: "call_1" }, output);
    expect(output.env).toEqual({ AMICO_SESSION_ID: "ses_abc123" });
  });
  it("keeps other plugins' env contributions", () => {
    const output = { env: { OTHER: "x" } as Record<string, string> };
    applySessionEnv({ sessionID: "ses_1" }, output);
    expect(output.env).toEqual({ OTHER: "x", AMICO_SESSION_ID: "ses_1" });
  });
  it("no / non-string / empty sessionID → no change (never a bogus id)", () => {
    for (const input of [{}, { sessionID: 42 }, { sessionID: "" }] as unknown as { sessionID?: string }[]) {
      const output = { env: {} as Record<string, string> };
      applySessionEnv(input, output);
      expect(output.env).toEqual({});
    }
  });
  it("the AmicodeContext plugin registers the hook", async () => {
    const { AmicodeContext } = await import("../opencode-plugin/amicode_context");
    const hooks = (await AmicodeContext({})) as Record<string, unknown>;
    expect(typeof hooks["shell.env"]).toBe("function");
    const output = { env: {} as Record<string, string> };
    await (hooks["shell.env"] as (i: unknown, o: unknown) => Promise<void>)({ cwd: "/w", sessionID: "ses_hook" }, output);
    expect(output.env.AMICO_SESSION_ID).toBe("ses_hook");
  });
});
