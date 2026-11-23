import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#1650 — the concise switch survives composer remounts. The store and
// the per-key binding are pinned behaviorally by context/concise-mode.test.ts;
// this file pins the two WIRING seams those tests cannot reach:
//   - the composer reads/writes the session-keyed store, never component state
//   - the submit path promotes the new chat's draft value to the session key
//     at session creation, and ONLY on success (a failed create keeps the draft)
//
// SOURCE assertions, like submit-stream-gap.test.ts: createPromptSubmit pulls
// router/tabs/sync/permission contexts that have no provider harness here.

const submit = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")
const composer = readFileSync(join(import.meta.dir, "../prompt-input-v2.tsx"), "utf8")

const submitPrompt = submit.slice(submit.indexOf("const submitPrompt = async"))

describe("composer holds concise in the session-keyed store (#1650)", () => {
  test("no component-local concise signal (it would reset on every remount)", () => {
    expect(composer).not.toMatch(/const \[\w*concise\w*, *set\w*\] *= *createSignal/i)
  })

  test("binds the shared store under the session key, or the draft key in a new chat", () => {
    expect(composer).toContain("bindConcise(conciseMode, conciseKeyNow)")
    expect(composer).toContain("conciseKey.session(sdk().scope, sdk().directory, id)")
    expect(composer).toContain("conciseKey.draft(sdk().scope, sdk().directory, conciseSearch.draftId)")
  })

  test("the submit path reads the store-backed accessor at send time", () => {
    expect(composer).toContain("const conciseOn = concise.on")
    expect(composer).toContain("concise: conciseOn,")
  })
})

describe("new chat → session: the draft's concise value follows the session (#1650)", () => {
  test("the switch and the draft key are captured before the first await", () => {
    const firstAwait = submitPrompt.search(/^\s+(const \w+ = )?await /m)
    const atSend = submitPrompt.indexOf("const conciseAtSend = input.concise?.()")
    const draftKey = submitPrompt.indexOf(
      "const conciseDraftKey = conciseKey.draft(sdk().scope, projectDirectory, search.draftId)",
    )
    expect(atSend).toBeGreaterThan(-1)
    expect(draftKey).toBeGreaterThan(-1)
    expect(atSend).toBeLessThan(firstAwait)
    expect(draftKey).toBeLessThan(firstAwait)
    // the draft key is derived from the same directory the composer keys on
    expect(submitPrompt).toContain("const projectDirectory = sdk().directory")
  })

  test("promotion happens inside the successful-create transition, beside the agent/model promotion", () => {
    const created = submitPrompt.indexOf("if (created) {")
    const localPromote = submitPrompt.indexOf("local.session.promote(")
    const promote = submitPrompt.indexOf(
      "conciseMode.promote(conciseDraftKey, conciseKey.session(sdk().scope, sessionDirectory, session.id))",
    )
    const handoff = submitPrompt.indexOf("tabs.promoteDraft(")
    expect(created).toBeGreaterThan(-1)
    expect(promote).toBeGreaterThan(localPromote)
    expect(localPromote).toBeGreaterThan(created)
    // promoted before the draft tab is replaced, so the session composer reads it on mount
    expect(promote).toBeLessThan(handoff)
  })

  test("promotion is the only write: a failed session create leaves the draft value for the retry", () => {
    expect(submit.match(/conciseMode\.promote\(/g)).toHaveLength(1)
    expect(submit).not.toMatch(/conciseMode\.set\(/)
  })
})
