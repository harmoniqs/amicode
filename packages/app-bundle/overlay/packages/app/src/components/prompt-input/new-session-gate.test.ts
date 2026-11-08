import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { releaseNewSessionSubmit, tryEnterNewSessionSubmit, withNewSessionGate } from "./new-session-gate"

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

// Wiring pin (the controller needs the whole provider tree, so it is pinned by
// source): a draft submit goes through the gate, keyed by scope + directory +
// draft id; a submit in an existing session bypasses it.
describe("handleSubmit wiring", () => {
  const submit = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")
  test("new-chat submits run under the gate; existing-session submits do not", () => {
    expect(submit).toContain("if (params.id) return submitPrompt(event)")
    expect(submit).toContain('ScopedKey.from(sdk().scope, sdk().directory, "new-session", search.draftId ?? "")')
    expect(submit).toContain("await withNewSessionGate(key, () => submitPrompt(event))")
  })
  test("handleSubmit is the only exported submit entry point", () => {
    expect(submit).toMatch(/return \{\s*abort,\s*handleSubmit,\s*\}/)
  })
})
