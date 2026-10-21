// #1778 — a running shell tool's output preview is throttled: the first update
// goes out at once, then at most one per 200 ms (a trailing update carries the
// latest output), and the final output is always delivered when the command
// completes. Every update is a `message.part.updated` on the live stream
// carrying up to 30 KB of preview, so an unthrottled chatty command floods it.
// The throttle itself runs on effect's Clock (driven by TestClock here); the
// shell tool is then exercised with real chatty commands. Harness trimmed from
// shell.test.ts (upstream).
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Clock, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { OUTPUT_THROTTLE_MS, makeOutputThrottle } from "../../src/tool/shell-output-throttle"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import type { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

Shell.acceptable.reset()
const projectRoot = path.join(__dirname, "../..")
const bin = `"${process.execPath.replaceAll("\\", "/")}"`
const script = (code: string) => {
  const shell = Shell.name(Shell.acceptable())
  const text = `${bin} -e ${shell === "cmd" ? `"${code}"` : `'${code}'`}`
  return shell === "pwsh" || shell === "powershell" ? `& ${text}` : text
}

/** Run the shell tool, recording every output preview update it publishes. */
const runRecording = (command: string) =>
  Effect.gen(function* () {
    const updates: { at: number; output: string }[] = []
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_i1778"),
      messageID: MessageID.make("msg_i1778"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: (input) =>
        Effect.sync(() => {
          const output = (input.metadata as { output?: string })?.output
          if (output) updates.push({ at: performance.now(), output })
        }),
      ask: () => Effect.void,
    }
    const tool = yield* (yield* ShellTool).init()
    const started = performance.now()
    const result = yield* tool.execute({ command }, ctx)
    return { updates, result, elapsed: performance.now() - started }
  }).pipe(provideInstance(projectRoot))

describe("shell output throttle (#1778)", () => {
  it.effect("the first update goes out at once; updates inside 200 ms coalesce into one trailing update", () =>
    Effect.gen(function* () {
      const sent: { at: number; output: string }[] = []
      const throttle = yield* makeOutputThrottle((output) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          sent.push({ at, output })
        }),
      )
      expect(OUTPUT_THROTTLE_MS).toBe(200)

      yield* throttle.offer("a")
      expect(sent).toEqual([{ at: 0, output: "a" }])

      yield* throttle.offer("ab")
      yield* TestClock.adjust("50 millis")
      yield* throttle.offer("abc")
      yield* TestClock.adjust("149 millis")
      expect(sent).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      expect(sent).toEqual([
        { at: 0, output: "a" },
        { at: 200, output: "abc" },
      ])

      // quiet afterwards: nothing new, nothing sent
      yield* TestClock.adjust("1 second")
      expect(sent).toHaveLength(2)
      // after a quiet spell the next update goes out at once again
      yield* throttle.offer("abcd")
      expect(sent.at(-1)).toEqual({ at: 1200, output: "abcd" })
    }),
  )

  it.effect("a steady stream of output yields at most one update per 200 ms, the latest each time", () =>
    Effect.gen(function* () {
      const sent: { at: number; output: string }[] = []
      const throttle = yield* makeOutputThrottle((output) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          sent.push({ at, output })
        }),
      )
      let output = ""
      for (let i = 0; i < 200; i++) {
        output += `${i}\n`
        yield* throttle.offer(output)
        yield* TestClock.adjust("10 millis")
      }
      expect(sent.length).toBeLessThanOrEqual(1 + 2000 / 200)
      expect(sent.length).toBeGreaterThanOrEqual(2000 / 200)
      for (let i = 1; i < sent.length; i++) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(200)
      expect(sent.map((s) => s.output.length)).toEqual([...sent.map((s) => s.output.length)].sort((a, b) => a - b))
    }),
  )

  it.effect("flush delivers unsent output at once, cancels the pending trailing update, and is idempotent", () =>
    Effect.gen(function* () {
      const sent: { at: number; output: string }[] = []
      const throttle = yield* makeOutputThrottle((output) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          sent.push({ at, output })
        }),
      )
      yield* throttle.offer("a")
      yield* throttle.offer("ab")
      yield* TestClock.adjust("20 millis")
      yield* throttle.flush
      expect(sent).toEqual([
        { at: 0, output: "a" },
        { at: 20, output: "ab" },
      ])
      yield* TestClock.adjust("1 second")
      yield* throttle.flush
      expect(sent).toHaveLength(2)
    }),
  )
})

describe("tool.shell — throttled output updates (#1778)", () => {
  it.live(
    "a command printing continuously publishes at most about five output updates per second",
    () =>
      Effect.gen(function* () {
        const { updates, result, elapsed } = yield* runRecording(
          script(
            "for (let i = 0; i < 150; i++) { process.stdout.write(`line-${i}\\n`); await Bun.sleep(6) } process.stdout.write(`line-END\\n`)",
          ),
        )
        expect(result.metadata.exit).toBe(0)
        // first update at once, then <= 1 per 200 ms, plus the final flush on completion
        expect(updates.length).toBeLessThanOrEqual(2 + Math.ceil(elapsed / OUTPUT_THROTTLE_MS))
        expect(updates.length).toBeGreaterThan(1)
        // the final output is delivered on completion: the last update is the full output
        expect(updates.at(-1)!.output).toContain("line-END")
        expect(updates.at(-1)!.output).toBe(result.metadata.output)
      }),
    20_000,
  )

  it.live(
    "output that lands inside the throttle window just before exit is still delivered",
    () =>
      Effect.gen(function* () {
        const { updates, result } = yield* runRecording(
          script("process.stdout.write(`first\\n`); await Bun.sleep(30); process.stdout.write(`last\\n`)"),
        )
        expect(result.metadata.exit).toBe(0)
        expect(updates[0].output).toContain("first")
        expect(updates.at(-1)!.output).toContain("last")
        expect(updates.at(-1)!.output).toBe(result.metadata.output)
      }),
    20_000,
  )
})
