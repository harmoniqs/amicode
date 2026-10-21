// 2026-10-05 (#775, the final wedge piece): a looping/never-ending provider
// stream accumulated unbounded in the publisher's fragment buffers and wedged
// the hub repeatedly (heap ~10MB/s to 3.1GB, main thread saturated, HTTP
// silent — the full incident narrative in the publish-llm-event.ts guard).
// This pins the guard: deltas past the cap DIE with the honest named error
// instead of accumulating, and the caps are env-overridable for exactly this
// kind of test.
import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { createLLMEventPublisher } from "../../src/session/runner/publish-llm-event"

const stubEvents = {
  publish: () => Effect.void,
} as any

const caps = { fragment: 1000, message: 4000 }

describe("stream overflow guard (#775)", () => {
  it("deltas past the fragment cap die with the named overflow error", async () => {
    const pub = createLLMEventPublisher(stubEvents, {
      sessionID: "ses_test" as any,
      agent: "build",
      model: { providerID: "test", modelID: "m" } as any,
      streamCaps: caps,
    })

    const started = await Effect.runPromiseExit(
      pub.publish({ type: "text-start", id: "txt_1" } as any),
    )
    expect(started._tag).toBe("Success")

    // under the cap: fine
    const under = await Effect.runPromiseExit(
      pub.publish({ type: "text-delta", id: "txt_1", text: "a".repeat(800) } as any),
    )
    expect(under._tag).toBe("Success")

    // past the 1000-byte cap: the honest death, not accumulation
    const over = await Effect.runPromiseExit(
      pub.publish({ type: "text-delta", id: "txt_1", text: "a".repeat(500) } as any),
    )
    expect(over._tag).toBe("Failure")
    const rendered = JSON.stringify(over._tag === "Failure" ? over.cause : over)
    expect(rendered).toContain("stream overflow")
    expect(rendered).toContain("fragment")
  })

  it("the message-level cap dies across MULTIPLE fragments", async () => {
    const pub = createLLMEventPublisher(stubEvents, {
      sessionID: "ses_test2" as any,
      agent: "build",
      model: { providerID: "test", modelID: "m" } as any,
      streamCaps: caps,
    })

    await Effect.runPromiseExit(pub.publish({ type: "text-start", id: "t1" } as any))
    // each fragment stays under the 1000-byte cap, but the message total
    // (4000) trips on the 5th fragment
    let failedAt: string | undefined
    for (let i = 1; i <= 6; i++) {
      const id = `t${i}`
      await Effect.runPromiseExit(pub.publish({ type: "text-start", id } as any))
      const res = await Effect.runPromiseExit(
        pub.publish({ type: "text-delta", id, text: "b".repeat(900) } as any),
      )
      if (res._tag === "Failure") {
        failedAt = id
        expect(JSON.stringify(res.cause)).toContain("stream overflow")
        break
      }
    }
    expect(failedAt).toBeDefined()
  })
})
