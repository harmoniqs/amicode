import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import {
  isNewSessionStarting,
  newSessionKey,
  releaseNewSessionSubmit,
  tryEnterNewSessionSubmit,
  withNewSessionGate,
} from "./new-session-gate"

// #2157: pressing Enter again while a new chat was still starting created a
// second session with the same first message. The gate admits one new-session
// submit per draft at a time.

const deferred = () => {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("withNewSessionGate", () => {
  test("a second submit from the same draft while the first is in flight does not run", async () => {
    const creates: string[] = []
    const slowCreate = deferred()
    const first = withNewSessionGate("draft-a", async () => {
      creates.push("first")
      await slowCreate.promise
    })
    // the user presses Enter again (and again) while the create is slow
    expect(await withNewSessionGate("draft-a", async () => void creates.push("second"))).toBe(false)
    expect(await withNewSessionGate("draft-a", async () => void creates.push("third"))).toBe(false)
    slowCreate.resolve()
    expect(await first).toBe(true)
    expect(creates).toEqual(["first"])
  })

  test("after the first settles the draft can submit again", async () => {
    await withNewSessionGate("draft-b", async () => {})
    let ran = false
    expect(await withNewSessionGate("draft-b", async () => void (ran = true))).toBe(true)
    expect(ran).toBe(true)
  })

  test("a failed create releases the gate, so the next submit retries", async () => {
    await expect(
      withNewSessionGate("draft-c", async () => {
        throw new Error("create failed")
      }),
    ).rejects.toThrow("create failed")
    let retried = false
    expect(await withNewSessionGate("draft-c", async () => void (retried = true))).toBe(true)
    expect(retried).toBe(true)
  })

  test("two different drafts can start sessions at the same time", async () => {
    const a = deferred()
    const first = withNewSessionGate("pane-1", () => a.promise)
    let ran = false
    expect(await withNewSessionGate("pane-2", async () => void (ran = true))).toBe(true)
    expect(ran).toBe(true)
    a.resolve()
    expect(await first).toBe(true)
  })

  test("tryEnter/release pair directly", () => {
    expect(tryEnterNewSessionSubmit("raw")).toBe(true)
    expect(tryEnterNewSessionSubmit("raw")).toBe(false)
    releaseNewSessionSubmit("raw")
    expect(tryEnterNewSessionSubmit("raw")).toBe(true)
    releaseNewSessionSubmit("raw")
  })
})

// #2158: on a busy engine the create alone can take seconds, and the composer
// still showed the text with nothing moving. The gate's in-flight state is the
// "this new chat is starting" signal: it turns on the moment Enter is pressed
// and off when the submit settles, and it is reactive so the view can show it.
describe("isNewSessionStarting", () => {
  test("is true from submit until the submit settles, and only for that draft", async () => {
    const create = deferred()
    expect(isNewSessionStarting("draft-s")).toBe(false)
    const run = withNewSessionGate("draft-s", () => create.promise)
    expect(isNewSessionStarting("draft-s")).toBe(true)
    expect(isNewSessionStarting("draft-other")).toBe(false)
    create.resolve()
    await run
    expect(isNewSessionStarting("draft-s")).toBe(false)
  })

  test("is cleared when the create fails", async () => {
    await withNewSessionGate("draft-f", async () => {
      throw new Error("create failed")
    }).catch(() => {})
    expect(isNewSessionStarting("draft-f")).toBe(false)
  })

  // bun resolves solid-js to its server build under this test config (effects
  // never run), so reactivity is pinned by source: the in-flight set lives in
  // a signal that isNewSessionStarting reads and every enter/release writes.
  test("is reactive: the in-flight set is a signal read by isNewSessionStarting", () => {
    const gate = readFileSync(join(import.meta.dir, "new-session-gate.ts"), "utf8")
    expect(gate).toContain("const [inFlight, setInFlight] = createSignal<ReadonlySet<string>>(")
    expect(gate).toMatch(/isNewSessionStarting\(key: string\): boolean \{\s*return inFlight\(\)\.has\(key\)/)
    expect(gate.match(/setInFlight\(/g)?.length).toBe(2)
  })
})

describe("newSessionKey", () => {
  test("keys a draft by server scope, project directory and draft id", () => {
    const scope = "scope" as ServerScope
    expect(newSessionKey(scope, "/work", "d1")).toBe(ScopedKey.from(scope, "/work", "new-session", "d1"))
    expect(newSessionKey(scope, "/work", undefined)).toBe(ScopedKey.from(scope, "/work", "new-session", ""))
  })
})

// Wiring pin (the controller needs the whole provider tree, so it is pinned by
// source): a draft submit goes through the gate, keyed by scope + directory +
// draft id; a submit in an existing session bypasses it.
describe("handleSubmit wiring", () => {
  const submit = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")
  test("new-chat submits run under the gate; existing-session submits do not", () => {
    expect(submit).toContain("if (params.id) return submitPrompt(event)")
    expect(submit).toContain("newSessionKey(sdk().scope, sdk().directory, search.draftId)")
    expect(submit).toMatch(/await withNewSessionGate\(key, async \(\) => \{[^}]*await submitPrompt\(event,/)
  })
  test("handleSubmit is the only exported submit entry point", () => {
    expect(submit).toMatch(/return \{\s*abort,\s*handleSubmit,\s*\}/)
  })
})
