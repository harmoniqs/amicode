// Contract: plugins reach the engine through `fromPromise` -> `SdkPlugins.register`, and a plugin file loaded through
// the host's DYNAMIC import paths (a module named in AMICODE_HOST_PLUGIN_CONFIG; the extension's context builders under
// context.extensionDir) registers and runs inside a real host process. These two non-literal `import()` sites are the
// scan's acknowledged "underivable" imports (registry.ts DYNAMIC_IMPORTS); this is the contract that stands in for them.
// Real host process, loopback only (ports 52200-52299), a loopback model, no credentials.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanupContract, contractPort, contractSandbox, startContractHost, stopContractHost, waitFor, type ContractHost } from "./support.ts"

afterAll(cleanupContract)

const sb = contractSandbox("loader")
const log = path.join(sb.root, "user-plugin.log")
const extension = path.join(sb.root, "extension")
const requests: { body: any }[] = []
let provider: ReturnType<typeof Bun.serve>
let host: ContractHost

/** A one-script OpenAI-compatible chat endpoint: first turn asks for a shell command, then answers. */
function sse(reply: { text: string } | { tool: { name: string; arguments: object } }) {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  const frames =
    "text" in reply
      ? [chunk({ role: "assistant", content: "" }), chunk({ content: reply.text }), chunk({}, "stop", { usage })]
      : [
          chunk({ role: "assistant", content: null }),
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) } }] }),
          chunk({}, "tool_calls", { usage }),
        ]
  return [...frames, "data: [DONE]\n\n"].join("")
}

beforeAll(async () => {
  fs.mkdirSync(extension)
  fs.writeFileSync(path.join(extension, "stack_state.ts"), `export const buildStackStateBlock = () => null\n`)
  fs.writeFileSync(path.join(extension, "setup_state.ts"), `export const buildSetupStateSection = () => null\n`)
  fs.writeFileSync(
    path.join(extension, "mode_block.ts"),
    `export const deployedModesRoot = () => "/unused"\nexport const buildModeBlock = async (d: any) => "CONTRACT-MODE-BLOCK agent=" + (await d.engineClient.session.get({})).data.agent\n`,
  )
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: await contractPort(),
    async fetch(request) {
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const index = requests.push({ body }) - 1
      return new Response(sse(index === 0 ? { tool: { name: "shell", arguments: { command: "touch loader-marker" } } } : { text: "done" }), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const providerConfig = {
    providers: { fake: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "not-a-real-key" }, models: { m: {} } } },
  }
  host = await startContractHost(sb, {
    PROBE_FILE: log,
    AMICODE_HOST_PLUGIN_CONFIG: JSON.stringify({ modules: [path.join(import.meta.dir, "fixtures/user-plugin.ts")], context: { extensionDir: extension } }),
    AMICODE_HOST_SERVER_OPTIONS: JSON.stringify({
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(providerConfig) },
    }),
  })
}, 90_000)

afterAll(async () => {
  provider?.stop(true)
  if (host) await stopContractHost(host)
})

describe("contract: a plugin file loaded through the dynamic import path registers and its hooks fire", () => {
  test("the user plugin's setup ran, and its `context` and `permission.evaluate` hooks fired during a real model turn", async () => {
    const headers = { ...host.headers, "content-type": "application/json" }
    const created = (await (
      await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "loader", location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) })
    ).json()) as { data: { id: string } }
    await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) })
    await waitFor(() => requests.length >= 2, { timeoutMs: 45_000, what: "the model turn (tool call, then answer)" })

    const lines = fs.readFileSync(log, "utf8").split("\n")
    expect(lines).toContain("setup")
    expect(lines.some((line) => line.startsWith("context agent="))).toBe(true)
    expect(lines).toContain("evaluate shell")

    // The plugin's own `context` hook edited the wire request ...
    const system = requests[0]!.body.messages.find((m: any) => m.role === "system").content as string
    expect(system).toContain("USER-PLUGIN-CONTEXT")
    // ... the host's permission plugin (also registered through fromPromise) refused the shell command by default ...
    const toolResults = requests[1]!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))
    expect(toolResults.join("\n")).toContain("default-deny: no grant for shell")
    expect(fs.existsSync(path.join(sb.work, "loader-marker"))).toBe(false)
  }, 90_000)

  test("the extension's context builders loaded from context.extensionDir (path.join dynamic import) reach the model request", () => {
    const system = requests[0]!.body.messages.find((m: any) => m.role === "system").content as string
    expect(system).toContain("CONTRACT-MODE-BLOCK agent=build")
  })

  test("a plugin file that is not a plugin is refused at start with the variable named, not served around", async () => {
    const bad = contractSandbox("loader-bad")
    const file = path.join(bad.root, "not-a-plugin.ts")
    fs.writeFileSync(file, `export default { id: 42 }\n`)
    await expect(startContractHost(bad, { AMICODE_HOST_PLUGIN_CONFIG: JSON.stringify({ modules: [file], context: { extensionDir: null } }) })).rejects.toThrow(/AMICODE_HOST_PLUGIN_CONFIG|host exited early/)
  }, 60_000)

  test("cleanup runs on shutdown", async () => {
    await stopContractHost(host)
    expect(fs.readFileSync(log, "utf8").split("\n")).toContain("cleanup")
  }, 30_000)
})
