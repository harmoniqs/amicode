import { appendFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { createSdkForServer } from "@/utils/server"

// #1779 — the app's global-stream READER: the SDK's SSE reader
// (`@opencode-ai/sdk/v2` core/serverSentEvents.gen.ts) that server-sdk.tsx reads
// the global stream through, driven exactly as the app drives it —
// `createSdkForServer(...).global.event({ onSseEvent })` — with a fetch that
// answers with chosen byte chunks, so a test can place every chunk boundary.
// (Each body chunk is one read: TextDecoderStream decodes chunk by chunk and
// holds back a code point split across two.)

const SERVER = { url: "http://127.0.0.1:4096" }

/** What one parsed frame reports through `onSseEvent` (the app reads `id`). */
type Frame = { data: unknown; event?: string; id?: string; retry?: number }

/** A fetch that answers the n-th request with the n-th delivery's chunks, one
 *  body read per chunk. A delivery with `fail` errors its body after its chunks
 *  (a dropped link). Every request is recorded. */
function streamFetch(deliveries: Array<{ chunks: Uint8Array[]; fail?: boolean }>, requests: Request[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const delivery = deliveries[Math.min(requests.length, deliveries.length - 1)]
    requests.push(request)
    let next = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < delivery.chunks.length) controller.enqueue(delivery.chunks[next++])
        else if (delivery.fail) controller.error(new Error("link dropped"))
        else controller.close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
}

/** Read the global stream to its end: every frame `onSseEvent` reported, and
 *  every event the stream yielded, in order. */
async function readStream(
  deliveries: Array<{ chunks: Uint8Array[]; fail?: boolean }>,
  requests: Request[] = [],
): Promise<{ frames: Frame[]; events: unknown[] }> {
  const sdk = createSdkForServer({ server: SERVER, fetch: streamFetch(deliveries, requests) as typeof fetch })
  const frames: Frame[] = []
  const result = await sdk.global.event({
    onSseEvent: (frame: Frame) => frames.push({ ...frame }),
    sseSleepFn: async () => {},
  })
  const events: unknown[] = []
  for await (const event of result.stream) events.push(event)
  return { frames, events }
}

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)

// ── #1771's chunked large-frame fixture ─────────────────────────────────────
// Ported verbatim from the extension's engine-shaped fixtures
// (test/fixtures/engine_stream/engine_frames.ts `largeSummaryFrame` /
// `chunkBytes`) — the app suite cannot import them: a `message.updated` summary
// frame whose `info.summary.diffs[].patch` text brings it to ≥ 10 MB of UTF-8,
// with non-ASCII text so a 64 KB byte boundary can fall inside a code point.

const TEN_MB = 10 * 1024 * 1024
const CHUNK_64K = 64 * 1024
const EPOCH = "bG9jYWwx"

function largeSummaryFrame(seq: number, targetBytes = TEN_MB): { frame: string; event: unknown } {
  const lines: string[] = []
  for (let i = 0; i < 1400; i++) lines.push(`+  const row${i} = "résumé → ${"x".repeat(60)}";`)
  const patch = `@@ -1,0 +1,1400 @@\n${lines.join("\n")}\n`
  const perDiff = encoder.encode(JSON.stringify(patch)).length + 96
  const count = Math.max(1, Math.ceil(targetBytes / perDiff))
  const diffs = Array.from({ length: count }, (_, i) => ({
    file: `src/module_${i}.ts`,
    patch,
    additions: 1400,
    deletions: 0,
    status: "modified",
  }))
  const event = {
    directory: "/Users/jj/harmoniqs/amicode",
    project: "prj_0fixture",
    payload: {
      id: "evt_summary",
      type: "message.updated",
      properties: { info: { id: "msg_summary", sessionID: "ses_large", role: "user", summary: { diffs } } },
    },
  }
  return { frame: `id: ${EPOCH}:${seq}\ndata: ${JSON.stringify(event)}\n\n`, event }
}

/** Split text's UTF-8 BYTES into `size` pieces — how the network delivers it. */
function chunkBytes(text: string, size = CHUNK_64K): Uint8Array[] {
  const all = encoder.encode(text)
  const out: Uint8Array[] = []
  for (let off = 0; off < all.length; off += size) out.push(all.subarray(off, off + size))
  return out
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/** #1779 AC1's assertion, made robust: a warm-up, then INTERLEAVED trials (both
 *  deliveries see the same machine noise), the median of each, and a generous
 *  factor. A quadratic reader misses it by an order of magnitude.
 *  `SPLIT_RATIO_LOG` (a file path) records each run's ratio for a flake report. */
async function readTimeRatio(whole: Uint8Array[], chunked: Uint8Array[]) {
  const timed = async (chunks: Uint8Array[]) => {
    const t0 = performance.now()
    await readStream([{ chunks }])
    return performance.now() - t0
  }
  for (let i = 0; i < 2; i++) {
    await timed(whole)
    await timed(chunked)
  }
  const one: number[] = []
  const many: number[] = []
  for (let i = 0; i < 7; i++) {
    one.push(await timed(whole))
    many.push(await timed(chunked))
  }
  const wholeMs = median(one)
  const chunkedMs = median(many)
  return { ratio: chunkedMs / wholeMs, wholeMs, chunkedMs }
}
const SPLIT_RATIO_FACTOR = 3

describe("#1779 AC1 — the app reader splits a 10 MB frame in 64 KB chunks within a small constant factor of one chunk", () => {
  test(
    "chunked ÷ single-chunk read time (medians) stays ≤ 3×, and both deliver the one event with its SSE id",
    async () => {
      const big = largeSummaryFrame(1)
      const whole = [bytes(big.frame)]
      const chunked = chunkBytes(big.frame)
      expect(whole[0].length).toBeGreaterThanOrEqual(TEN_MB)
      expect(chunked.length).toBeGreaterThan(160)
      for (const chunks of [whole, chunked]) {
        const { frames, events } = await readStream([{ chunks }])
        expect(frames.map((f) => f.id)).toEqual([`${EPOCH}:1`]) // #1777's cursor source
        expect(events).toHaveLength(1)
        expect(Bun.deepEquals(events[0], big.event)).toBe(true) // no 10 MB diff on failure
      }
      const { ratio, wholeMs, chunkedMs } = await readTimeRatio(whole, chunked)
      if (process.env.SPLIT_RATIO_LOG)
        appendFileSync(process.env.SPLIT_RATIO_LOG, `app ${ratio.toFixed(3)} ${wholeMs.toFixed(2)} ${chunkedMs.toFixed(2)}\n`)
      expect(ratio).toBeLessThanOrEqual(SPLIT_RATIO_FACTOR)
    },
    120_000,
  )
})
