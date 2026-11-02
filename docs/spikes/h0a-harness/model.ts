// A PACED loopback OpenAI-compatible chat endpoint. Unlike the test fake it streams: a role frame, then content (or
// reasoning-then-content) frames spread over a seeded-random 2-8 s, then finish + usage. An instant fake flatters the
// host (no open streams to fan out); this one keeps every turn "in flight" for seconds, as a real provider would.
//
//   request n (1-based, counted by arrival)   a request whose last message is a tool result -> text
//   n % 5 == 0                                 a `shell` tool call (the host's default-deny policy refuses it)
//   n % 7 == 0 (and not the above)            a reasoning-bearing turn
//
// Cheap on purpose: one setTimeout chain per stream, no per-frame allocation beyond the SSE string.
import { args, assertPort, rngFor, uniform } from "./common.ts"

export type Kind = "text" | "reasoning" | "tool"
export type ModelOptions = { port: number; seed: number; minMs: number; maxMs: number; frameMs: number }
export type Frame = { atMs: number; sse: string }
export type Plan = { kind: Kind; durationMs: number; frames: Frame[] }

export const kindFor = (n: number, toolFollowup: boolean): Kind => {
  if (toolFollowup) return "text"
  if (n % 5 === 0) return "tool"
  if (n % 7 === 0) return "reasoning"
  return "text"
}

const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-h0a", object: "chat.completion.chunk", created: 1, model: "h0a", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
const usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }

/** The whole schedule of one response: pure and deterministic in (seed, n), whatever order requests arrive in. */
export function plan(options: Pick<ModelOptions, "seed" | "minMs" | "maxMs" | "frameMs">, n: number, toolFollowup = false): Plan {
  const random = rngFor(options.seed, n)
  const kind = kindFor(n, toolFollowup)
  const durationMs = Math.round(uniform(random, options.minMs, options.maxMs))
  const count = Math.max(4, Math.round(durationMs / options.frameMs))
  const at = (i: number) => Math.round((durationMs * i) / count)
  const frames: Frame[] = [{ atMs: 0, sse: chunk({ role: "assistant", content: kind === "tool" ? null : "" }) }]
  if (kind === "tool") {
    // Quiet until near the end, as a model "thinking" before it emits a call.
    frames.push({
      atMs: durationMs,
      sse: chunk({ tool_calls: [{ index: 0, id: `call_h0a_${n}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "echo h0a" }) } }] }),
    })
    frames.push({ atMs: durationMs, sse: chunk({}, "tool_calls", { usage }) + "data: [DONE]\n\n" })
    return { kind, durationMs, frames }
  }
  for (let i = 1; i < count; i++) {
    const reasoning = kind === "reasoning" && i <= count / 2
    frames.push({ atMs: at(i), sse: chunk(reasoning ? { reasoning_content: `thinking ${i} ` } : { content: `word${i} ` }) })
  }
  frames.push({ atMs: durationMs, sse: chunk({}, "stop", { usage }) + "data: [DONE]\n\n" })
  return { kind, durationMs, frames }
}

export function startModel(options: ModelOptions) {
  assertPort(options.port)
  const stats = { requests: 0, active: 0, maxActive: 0, completed: 0, aborted: 0, text: 0, reasoning: 0, tool: 0, other: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/__stats") return Response.json(stats)
      if (!url.pathname.endsWith("/chat/completions") || request.method !== "POST") {
        stats.other++
        return new Response("not found", { status: 404 })
      }
      const body = (await request.json().catch(() => undefined)) as { messages?: { role?: string }[] } | undefined
      const toolFollowup = body?.messages?.at(-1)?.role === "tool"
      const n = ++stats.requests
      const chosen = plan(options, n, toolFollowup)
      stats[chosen.kind]++
      stats.active++
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const finish = (aborted: boolean) => {
        if (finished) return
        finished = true
        stats.active--
        if (aborted) stats.aborted++
        else stats.completed++
      }
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            const startedAt = performance.now()
            let i = 0
            const step = () => {
              // Emit every frame that is due (the tool call and its finish share an instant), then sleep to the next.
              const now = performance.now() - startedAt
              while (i < chosen.frames.length && chosen.frames[i]!.atMs <= now + 1) controller.enqueue(encoder.encode(chosen.frames[i++]!.sse))
              if (i >= chosen.frames.length) {
                finish(false)
                controller.close()
                return
              }
              timer = setTimeout(step, Math.max(1, chosen.frames[i]!.atMs - (performance.now() - startedAt)))
            }
            step()
          },
          cancel() {
            if (timer) clearTimeout(timer)
            finish(true)
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    },
  })
  return {
    port: server.port as number,
    stats,
    stop: () => server.stop(true),
    /** The `config.content` providers block that points the engine at this server. */
    providerConfig: (models: string[]) => ({
      providers: {
        fake: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "not-a-real-key" },
          models: Object.fromEntries(models.map((id) => [id, {}])),
        },
      },
    }),
  }
}

if (import.meta.main) {
  const a = args(process.argv.slice(2))
  const model = startModel({
    port: Number(a.port),
    seed: Number(a.seed ?? 1),
    minMs: Number(a["min-s"] ?? 2) * 1000,
    maxMs: Number(a["max-s"] ?? 8) * 1000,
    frameMs: Number(a["frame-ms"] ?? 250),
  })
  console.log(JSON.stringify({ event: "listening", port: model.port, pid: process.pid }))
  const bye = () => {
    model.stop()
    process.exit(0)
  }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
}
