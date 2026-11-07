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

/** One response body: its chunks, one body read each. With `failWhen`, the body
 *  errors (a dropped link) once that promise settles — never earlier, so no
 *  decoded chunk still queued in the pipe is discarded by the error. */
type Delivery = { chunks: Uint8Array[]; failWhen?: Promise<unknown> }

/** A fetch that answers the n-th request with the n-th delivery. Every request
 *  is recorded. */
function streamFetch(deliveries: Delivery[], requests: Request[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const delivery = deliveries[Math.min(requests.length, deliveries.length - 1)]
    requests.push(request)
    let next = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < delivery.chunks.length) controller.enqueue(delivery.chunks[next++])
        else if (delivery.failWhen) return delivery.failWhen.then(() => controller.error(new Error("link dropped")))
        else controller.close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
}

/** Read the global stream to its end: every frame `onSseEvent` reported, and
 *  every event the stream yielded, in order. `retryDelayMs` sets the SDK's
 *  reconnect delay (its default is 3000 ms, reported as each frame's `retry`). */
async function readStream(
  deliveries: Delivery[],
  requests: Request[] = [],
  opts: { onFrame?: (frame: Frame) => void; retryDelayMs?: number } = {},
): Promise<{ frames: Frame[]; events: unknown[] }> {
  const sdk = createSdkForServer({ server: SERVER, fetch: streamFetch(deliveries, requests) as typeof fetch })
  const frames: Frame[] = []
  const result = await sdk.global.event({
    onSseEvent: (frame: Frame) => {
      frames.push({ ...frame })
      opts.onFrame?.(frame)
    },
    ...(opts.retryDelayMs !== undefined ? { sseDefaultRetryDelay: opts.retryDelayMs } : {}),
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

/** Every way to cut `text`'s bytes into two chunks, and one byte at a time. */
function everySplit(text: string): Uint8Array[][] {
  const all = bytes(text)
  const deliveries: Uint8Array[][] = []
  for (let k = 1; k < all.length; k++) deliveries.push([all.subarray(0, k), all.subarray(k)])
  deliveries.push(Array.from({ length: all.length }, (_, i) => all.subarray(i, i + 1)))
  return deliveries
}

describe("#1779 AC2 — the app reader finds frame boundaries split across chunks, CRLF line endings included", () => {
  const stream = [
    `id: ${EPOCH}:0\ndata: {"payload":{"type":"server.connected"}}\n\n`, // LF, the engine's framing
    `id: ${EPOCH}:1\r\ndata: {"n":1,"text":"résumé → done"}\r\n\r\n`, // CRLF, non-ASCII
    `data: first line\r\ndata: second line\r\n\r\n`, // CRLF, multi-line data
    `event: ping\rdata: {"n":3}\r\r`, // CR line endings
    `data: {"n":4}\n\n`,
  ].join("")
  const expected: Frame[] = [
    { data: { payload: { type: "server.connected" } }, event: undefined, id: `${EPOCH}:0`, retry: 3000 },
    { data: { n: 1, text: "résumé → done" }, event: undefined, id: `${EPOCH}:1`, retry: 3000 },
    { data: "first line\nsecond line", event: undefined, id: `${EPOCH}:1`, retry: 3000 },
    { data: { n: 3 }, event: "ping", id: `${EPOCH}:1`, retry: 3000 },
    { data: { n: 4 }, event: undefined, id: `${EPOCH}:1`, retry: 3000 },
  ]

  test("in one chunk: each frame once, with its id", async () => {
    const { frames, events } = await readStream([{ chunks: [bytes(stream)] }])
    expect(frames).toEqual(expected)
    expect(events).toEqual(expected.map((f) => f.data))
  })

  test("cut at EVERY byte — a delimiter, a CRLF, a code point split between two chunks — and byte by byte: the same frames, no extra, none merged", async () => {
    for (const chunks of everySplit(stream)) {
      const { frames, events } = await readStream([{ chunks }])
      const cuts = chunks.map((c) => c.length)
      expect({ cuts, frames }).toEqual({ cuts, frames: expected })
      expect({ cuts, events }).toEqual({ cuts, events: expected.map((f) => f.data) })
    }
  })

  test("a stream that ENDS on a CR line ending still delivers its last frame (a held \\r is a line end at the end)", async () => {
    const crOnly = `data: {"n":1}\r\rdata: {"n":2}\r\r`
    for (const chunks of [[bytes(crOnly)], ...everySplit(crOnly)]) {
      const { events } = await readStream([{ chunks }])
      expect({ cuts: chunks.map((c) => c.length), events }).toEqual({ cuts: chunks.map((c) => c.length), events: [{ n: 1 }, { n: 2 }] })
    }
  })
})

describe("#1779 AC3 — the app reader's framing is unchanged: multi-line data, event names, ids, retry fields", () => {
  // Pinned against the generated reader as it was before #1779, in one chunk and
  // cut at every byte (the parse of each frame must not depend on where it was cut).
  const stream = [
    `: a comment line is ignored\nevent: message.updated\nid: ${EPOCH}:1\ndata: {"a":\ndata: 1}\n\n`, // multi-line data joins with \n
    `data:no-space\nretry: 5000\n\n`, // a field without a space; a retry sets the delay
    `data:    padded\nretry: soon\n\n`, // the reader strips all leading whitespace; a bad retry is ignored
    `: keep-alive\n\n`, // no data: reported, never yielded
    `id: ${EPOCH}:2\nevent: x\nevent: y\ndata: {"b":2}\n\n`, // last event name wins
    `data: {"c":3}\n\n`, // no id line: the last id stands (SSE last-event-ID)
    `\ndata: {"d":4}\n\n`, // a stray blank line before a frame joins that frame (no empty dispatch)
    `id:\ndata: {"e":5}\n\n`, // an empty id resets it
    `data: {"lost":true}\n`, // incomplete at the end of the stream: discarded
  ].join("")
  const expected: Frame[] = [
    { data: { a: 1 }, event: "message.updated", id: `${EPOCH}:1`, retry: 3000 },
    { data: "no-space", event: undefined, id: `${EPOCH}:1`, retry: 5000 },
    { data: "padded", event: undefined, id: `${EPOCH}:1`, retry: 5000 },
    { data: undefined, event: undefined, id: `${EPOCH}:1`, retry: 5000 },
    { data: { b: 2 }, event: "y", id: `${EPOCH}:2`, retry: 5000 },
    { data: { c: 3 }, event: undefined, id: `${EPOCH}:2`, retry: 5000 },
    { data: { d: 4 }, event: undefined, id: `${EPOCH}:2`, retry: 5000 },
    { data: { e: 5 }, event: undefined, id: "", retry: 5000 },
  ]
  const yielded = [{ a: 1 }, "no-space", "padded", { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]

  test("in one chunk, and cut at every byte: the same frames, fields and events", async () => {
    for (const chunks of [[bytes(stream)], ...everySplit(stream)]) {
      const { frames, events } = await readStream([{ chunks }])
      const cuts = chunks.map((c) => c.length)
      expect({ cuts, frames }).toEqual({ cuts, frames: expected })
      expect({ cuts, events }).toEqual({ cuts, events: yielded })
    }
  })

  test("ids: after a dropped link the SDK's own retry carries the last id it parsed (the Last-Event-ID header #1777's sseFetch strips)", async () => {
    const requests: Request[] = []
    const first = `id: ${EPOCH}:6\ndata: {"n":6}\n\nid: ${EPOCH}:7\ndata: {"n":7}\n\n`
    let parsedLast!: () => void
    const dropLink = new Promise<void>((resolve) => (parsedLast = resolve))
    const { frames, events } = await readStream(
      [{ chunks: chunkBytes(first, 7), failWhen: dropLink }, { chunks: [bytes(`id: ${EPOCH}:8\ndata: {"n":8}\n\n`)] }],
      requests,
      { onFrame: (frame) => frame.id === `${EPOCH}:7` && parsedLast(), retryDelayMs: 0 },
    )
    expect(requests).toHaveLength(2)
    expect(requests[0].headers.get("last-event-id")).toBeNull()
    expect(requests[1].headers.get("last-event-id")).toBe(`${EPOCH}:7`)
    expect(frames.map((f) => f.id)).toEqual([`${EPOCH}:6`, `${EPOCH}:7`, `${EPOCH}:8`])
    expect(events).toEqual([{ n: 6 }, { n: 7 }, { n: 8 }])
  })
})
