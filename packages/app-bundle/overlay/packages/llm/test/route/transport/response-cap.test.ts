// 2026-10-05 (#775, the wedge's surviving leg): an unterminated/never-ending
// provider response body buffered without bound in the SSE framer — heap
// ~10MB/s, zero frames reaching the publisher's caps, HTTP silent, engine
// dead until the watchdog. This pins the transport seam's response cap: an
// endless body dies at the byte count with the named error.
import { describe, it, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Framing, type Framing as FramingDef } from "../../../src/route/framing"

async function drive(body: Stream.Stream<Uint8Array, never>): Promise<{ tag: string; rendered: string }> {
  process.env.AMICODE_MAX_LLM_RESPONSE_BYTES = String(100_000)
  const mod = await import("../../../src/route/transport/http")
  delete process.env.AMICODE_MAX_LLM_RESPONSE_BYTES
  const transport = (mod as any).httpJson({ framing: Framing.sse })
  const fakeRuntime = {
    http: {
      execute: () =>
        Effect.succeed({
          stream: body,
          headers: new Headers(),
          status: 200,
          statusText: "OK",
        }),
    },
  } as never
  const prepared = { request: {} as never, framing: Framing.sse as FramingDef<string> }
  const frames = transport.frames(
    prepared,
    { model: { provider: "t", route: { id: "r" } } } as never,
    fakeRuntime,
  )
  const exit = (await Effect.runPromiseExit(Stream.runDrain(frames) as never)) as any
  const rendered = JSON.stringify(exit._tag === "Failure" ? exit.cause : exit)
  return { tag: exit._tag as string, rendered }
}

describe("llm response byte cap (#775)", () => {
  it("an endless unterminated body dies at the cap with the named error", async () => {
    // 500 chunks x 4096 bytes, no newline anywhere — the wedge shape; the
    // 100KB test cap trips after ~25 chunks.
    const chunk = new Uint8Array(4096).fill(97)
    const endless = Stream.make(...Array.from({ length: 500 }, () => chunk))
    const { tag, rendered } = await drive(endless)
    expect(tag).toBe("Failure")
    expect(rendered).toContain("llm response exceeded")
  })

  it("a bounded SSE body passes the cap untouched", async () => {
    const body = new TextEncoder().encode('data: {"ok":true}\n\ndata: [DONE]\n\n')
    const { tag } = await drive(Stream.make(body))
    expect(tag).toBe("Success")
  })
})
