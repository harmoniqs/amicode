import { describe, expect, test } from "bun:test"
import { createCompatibleApi } from "@/utils/server-compat"
import { CONCISE_DIRECTIVE, conciseSystem, sendFollowupDraft, type FollowupDraft } from "./submit"

// Concise mode (#1633 / critic follow-up): with the composer's concise switch
// ON, the hidden directive must ride the V1 request as the per-turn `system`
// instruction — and never as a visible text part. Drives the real send path
// (sendFollowupDraft → the server-compat V1 bridge → promptAsync) against a
// recording legacy client.

function harness() {
  const calls: Array<Record<string, unknown>> = []
  const legacy = {
    session: {
      promptAsync: async (body: Record<string, unknown>) => {
        calls.push(body)
        return { data: undefined }
      },
    },
  }
  // The v2 ("current") API shape the compat layer spreads + samples; only the
  // V1 path is exercised, so its methods are inert stubs.
  const inert = async () => undefined
  const current = {
    session: { prompt: inert, revert: { commit: inert } },
    file: {},
    integration: { connect: {}, oauth: {} },
    path: {},
    permission: {},
    project: {},
    pty: {},
    question: {},
    vcs: {},
  }
  const api = createCompatibleApi({
    protocol: Promise.resolve("v1"),
    current: current as never,
    legacy: () => legacy as never,
  }).session
  const optimistic: unknown[] = []
  const sync = {
    data: { command: [] },
    session: { optimistic: { add: (m: unknown) => optimistic.push(m), remove: () => {} } },
  }
  return { api, calls, sync: sync as never, serverSync: {} as never, optimistic }
}

const draft = (concise: boolean): FollowupDraft => ({
  sessionID: "ses_concise",
  sessionDirectory: "/work",
  prompt: [{ type: "text", content: "explain the pulse", start: 0, end: 17 }] as FollowupDraft["prompt"],
  context: [],
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude" },
  system: conciseSystem(concise),
})

describe("concise switch → V1 request", () => {
  test("ON: the hidden concise directive reaches promptAsync as `system`, not as a text part", async () => {
    const h = harness()
    expect(await sendFollowupDraft({ api: h.api, serverSync: h.serverSync, sync: h.sync, draft: draft(true) })).toBe(true)
    expect(h.calls).toHaveLength(1)
    const body = h.calls[0]!
    expect(body.system).toBe(CONCISE_DIRECTIVE)
    expect(body.sessionID).toBe("ses_concise")
    const parts = body.parts as Array<{ type: string; text?: string }>
    for (const part of parts) expect(part.text ?? "").not.toContain("Concise mode is on")
    expect(parts.some((part) => part.type === "text" && part.text?.includes("explain the pulse"))).toBe(true)
  })

  test("OFF: no system instruction is sent", async () => {
    const h = harness()
    await sendFollowupDraft({ api: h.api, serverSync: h.serverSync, sync: h.sync, draft: draft(false) })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.system).toBeUndefined()
  })
})
