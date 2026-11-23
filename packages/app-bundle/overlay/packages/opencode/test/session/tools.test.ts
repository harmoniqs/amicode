import { expect } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

// harmoniqs/amicode#2125 — the model often emits a shell write and a `read` of the
// same file as parallel tool calls in ONE assistant step. The AI SDK starts each
// tool's execute as its call streams in, so the read used to stat the file before
// the shell had finished writing it ("File not found" for a file `ls` shows), or
// read the previous bytes of a file being overwritten (a stale image). A read must
// observe the effects of the tool calls issued before it in the same step.
const writeThenReadRegistry = ToolRegistry.Service.of({
  ids: () => Effect.succeed(["bash", "read"]),
  all: () => Effect.succeed([]),
  named: () => Effect.die("unused"),
  tools: () =>
    Effect.succeed([
      {
        id: "bash",
        description: "writes a file after a delay, like a plotting script",
        parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
        jsonSchema: { type: "object", properties: {} },
        execute: (args: { path: string; content: string }) =>
          Effect.gen(function* () {
            yield* Effect.sleep("50 millis")
            fs.writeFileSync(args.path, args.content)
            return { title: "bash", metadata: {}, output: "" }
          }),
      } satisfies Tool.Def<any>,
      {
        id: "read",
        description: "reads a file",
        parameters: Schema.Struct({ filePath: Schema.String }),
        jsonSchema: { type: "object", properties: {} },
        execute: (args: { filePath: string }) =>
          Effect.gen(function* () {
            if (!fs.existsSync(args.filePath)) return yield* Effect.die(new Error(`File not found: ${args.filePath}`))
            return { title: "read", metadata: {}, output: fs.readFileSync(args.filePath, "utf8") }
          }),
      } satisfies Tool.Def<any>,
    ]),
})

const itWriteThenRead = testEffect(
  Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, fakeMcp()),
    Layer.succeed(Truncate.Service, fakeTruncate),
    RuntimeFlags.layer(),
    Layer.succeed(ToolRegistry.Service, writeThenReadRegistry),
  ),
)

// The macOS temp directory has two spellings (/tmp is a symlink to /private/tmp);
// elsewhere both spellings name the same directory.
function tempDirSpellings() {
  if (process.platform === "darwin") {
    const dir = fs.mkdtempSync("/tmp/oc-2125-")
    return { dir, spellings: [dir, path.join("/private", dir)] }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-2125-"))
  return { dir, spellings: [dir, dir] }
}

const resolveWriteThenRead = () =>
  SessionTools.resolve({
    agent,
    model,
    session: { id: sessionID, permission: [] } as unknown as Session.Info,
    processor: {
      message: {
        id: MessageID.ascending(),
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: () => Effect.die("unused"),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })

// Start the shell call, then the read, without awaiting in between — the order in
// which the AI SDK dispatches parallel tool calls from one step.
const writeThenRead = (
  tools: Record<string, { execute?: (args: any, opts: any) => any }>,
  writePath: string,
  readPath: string,
  content: string,
) => {
  const opts = (id: string) => ({ toolCallId: id, abortSignal: new AbortController().signal, messages: [] })
  const shell = tools.bash.execute!({ path: writePath, content }, opts("call-bash"))
  const read = tools.read.execute!({ filePath: readPath }, opts("call-read"))
  return Effect.promise(() => Promise.all([shell, read]).then(([, result]) => result.output as string))
}

for (const [writeIdx, readIdx, label] of [
  [0, 0, "same spelling"],
  [0, 1, "written as /tmp, read as /private/tmp"],
  [1, 0, "written as /private/tmp, read as /tmp"],
] as const) {
  itWriteThenRead.live(`read sees a file written by a shell call earlier in the same step (${label})`, () =>
    Effect.gen(function* () {
      const { dir, spellings } = tempDirSpellings()
      try {
        const tools = yield* resolveWriteThenRead()
        const output = yield* writeThenRead(
          tools,
          path.join(spellings[writeIdx], "fig.png"),
          path.join(spellings[readIdx], "fig.png"),
          "new figure",
        )
        expect(output).toBe("new figure")
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
}

itWriteThenRead.live("read after an in-place overwrite in the same step returns the new content", () =>
  Effect.gen(function* () {
    const { dir } = tempDirSpellings()
    try {
      const file = path.join(dir, "fig.png")
      fs.writeFileSync(file, "old figure")
      const tools = yield* resolveWriteThenRead()
      const output = yield* writeThenRead(tools, file, file, "new figure")
      expect(output).toBe("new figure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }),
)
