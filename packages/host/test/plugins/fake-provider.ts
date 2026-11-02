// A loopback OpenAI-compatible chat endpoint for end-to-end turns: it records every request exactly as it arrived
// (so a test can assert on the wire body the model would have received) and answers from a script. No credentials,
// no network beyond 127.0.0.1.
import { pluginPort } from "./support.ts"

export interface Recorded {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: any
}
export type Reply = { text: string; reasoning?: string } | { tool: { name: string; arguments: Record<string, unknown> } }

export async function fakeProvider(script: (recorded: Recorded, index: number) => Reply = () => ({ text: "ok" })) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: await pluginPort(),
    async fetch(request) {
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      const recorded = { url: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body }
      if (!recorded.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const index = requests.push(recorded) - 1
      return new Response(sse(script(recorded, index)), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
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

function sse(reply: Reply) {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  const frames =
    "text" in reply
      ? [
          chunk({ role: "assistant", content: "" }),
          ...(reply.reasoning ? [chunk({ reasoning_content: reply.reasoning })] : []),
          chunk({ content: reply.text }),
          chunk({}, "stop", { usage }),
        ]
      : [
          chunk({ role: "assistant", content: null }),
          chunk({ tool_calls: [{ index: 0, id: "call_fake_1", type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] }),
          chunk({}, "tool_calls", { usage }),
        ]
  return [...frames, "data: [DONE]\n\n"].join("")
}
