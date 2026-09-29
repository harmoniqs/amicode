import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

// #1646 (transcript self-heal) — outside a page load, a message.part.updated
// whose ordered parent message.updated was never seen (the mid-stream reconnect
// gap where the parent frame was lost and the lastEventID cursor could not
// replay it) used to be dropped silently, leaving the row permanently absent
// until a manual window reload. It now requests a forced resync to backfill the
// parent — debounced per session so a part burst yields at most one sync — and
// still refuses to resurrect a message it knows was removed.
//
// In its OWN file (not appended to server-session.test.ts) on purpose: that
// suite has documented positive cross-test dependencies (#1239), and a new
// describe block appended there shifts ordering and reddens an unrelated test.
// A dedicated file keeps these hermetic.

const sessionInfo = (id: string, parentID?: string) =>
  ({ id, parentID, time: { created: 1, updated: 1 } }) as Session

const textPart = (input: { id: string; sessionID: string; messageID: string }) =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text",
    text: "hi",
  }) as unknown as Part

// A client that records session.messages calls so we can count forced resyncs
// (a forced sync runs loadMessages → client.session.messages). `next()` returns
// a promise that resolves the moment the NEXT messages call lands, so tests
// await the resync deterministically rather than racing a timer (bun runs these
// in one shared process alongside server-session.test.ts; a setTimeout settle is
// not reliable across that boundary).
function recordingClient() {
  const calls: string[] = []
  let notify: (() => void) | undefined
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ data: sessionInfo(sessionID) }),
      messages: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        notify?.()
        return { data: [], cursor: { next: undefined } }
      },
    },
  } as unknown as OpencodeClient
  const nextCall = () =>
    new Promise<void>((resolve) => {
      notify = resolve
    })
  return { client, calls, nextCall }
}

const microtasks = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("#1646 — orphan-part self-heal", () => {
  test("a genuine orphan (missing parent, no active load) triggers a forced resync", async () => {
    const { client, calls, nextCall } = recordingClient()
    const session = createServerSession(client)
    session.apply({ type: "session.created", properties: { info: sessionInfo("ses_o") } })
    const landed = nextCall()
    // No message.updated for msg_o ever arrived — its parent frame was lost.
    session.apply({
      type: "message.part.updated",
      properties: { part: textPart({ id: "prt_1", sessionID: "ses_o", messageID: "msg_o" }) },
    })
    await landed
    expect(calls).toContain("ses_o")
    // The orphan part itself is NOT ordered into the list (no parent to anchor).
    expect(session.data.message["ses_o"] ?? []).toHaveLength(0)
  })

  test("a burst of orphan parts triggers at most one resync (the in-flight guard holds)", async () => {
    const { client, calls, nextCall } = recordingClient()
    const session = createServerSession(client)
    session.apply({ type: "session.created", properties: { info: sessionInfo("ses_b") } })
    const landed = nextCall()
    // The whole burst is applied synchronously. The per-session in-flight guard
    // is set synchronously (before the first sync's first await), so every later
    // orphan in the burst sees it set and launches no second resync. The novel-
    // messageID dedup independently collapses repeats of the same message.
    for (let i = 0; i < 5; i++) {
      session.apply({
        type: "message.part.updated",
        properties: { part: textPart({ id: `prt_${i}`, sessionID: "ses_b", messageID: `msg_${i}` }) },
      })
    }
    await landed
    await microtasks() // give any (erroneously) launched second resync time to land
    expect(calls.filter((s) => s === "ses_b")).toHaveLength(1)
  })

  test("a part for a KNOWN-REMOVED message never resurrects it and never resyncs", async () => {
    const { client, calls } = recordingClient()
    const session = createServerSession(client)
    session.apply({ type: "session.created", properties: { info: sessionInfo("ses_r") } })
    session.apply({ type: "message.removed", properties: { sessionID: "ses_r", messageID: "msg_dead" } })
    session.apply({
      type: "message.part.updated",
      properties: { part: textPart({ id: "prt_z", sessionID: "ses_r", messageID: "msg_dead" }) },
    })
    await microtasks() // a resync, if wrongly launched, would land within these
    expect(calls).not.toContain("ses_r")
    expect(session.data.message["ses_r"] ?? []).toHaveLength(0)
  })
})
