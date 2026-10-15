// amicode#1787 (S1) — the session list chip's WIRING, source-asserted per the
// repo's component-source-assertion pattern (session-header.test.tsx,
// home-archive.test.ts): the DECISION logic is pure + unit-tested in
// session-list-chip.tsx and the store semantics in server-session.test.ts;
// here we assert the SolidJS surface binds them — the chip renders on the home
// session row, rides the shared ServerSession store (the same question rows
// the S2 inbox reads), and is render-only (no timers, no fetches, no writes).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const homeSource = readFileSync(resolve(__dirname, "../home.tsx"), "utf8")
const chipSource = readFileSync(resolve(__dirname, "session-list-chip.tsx"), "utf8")
const avatarSource = readFileSync(resolve(__dirname, "project-avatar-state.ts"), "utf8")

function homeSessionRowBody(src: string): string {
  const start = src.indexOf("function HomeSessionRow(props: {")
  expect(start).toBeGreaterThan(-1)
  const next = src.indexOf("function HomeSessionSkeleton", start)
  expect(next).toBeGreaterThan(start)
  return src.slice(start, next)
}

describe("amicode#1787 — the session list chip renders on the home session row", () => {
  test("HomeSessionRow derives and renders the chip off the shared store", () => {
    const body = homeSessionRowBody(homeSource)
    expect(body).toContain("useSessionListChipState")
    expect(body).toContain("<SessionListStatusChip")
  })

  test("the chip reads the SHARED ServerSession store — the same leaves the S2 inbox derives from", () => {
    // The hook hands the derivation the per-server shared store's own `data`
    // (session_working / session_status / question) — not a per-directory
    // child-store view — so "waiting on question" is the SAME question map the
    // inbox's collectQuestionInbox walks (layout-new.tsx wires the inbox to
    // `serverSync().session.data.question`).
    expect(avatarSource).toContain("source: serverSync.session.data")
  })

  test("the chip component renders the tri-state with an honest-absence fallback (no chip when omitted)", () => {
    expect(chipSource).toContain('data-slot="session-list-chip"')
    expect(chipSource).toContain("data-kind={chip.kind}")
    // The omitted state renders NOTHING — absence never reads as idle.
    expect(chipSource).toContain("props.chip === undefined")
  })

  test("render-only: the chip adds no polling, no routes, no state writes (AC3/AC4)", () => {
    for (const forbidden of [
      "setInterval",
      "setTimeout",
      "requestAnimationFrame",
      "fetch(",
      "amicodeGet",
      "reconcileStatuses",
      ".set(",
      "produce(",
    ])
      expect(chipSource).not.toContain(forbidden)
    // The hook reads only — no store mutation from the chip lane.
    const hook = avatarSource.slice(avatarSource.indexOf("export function useSessionListChipState"))
    for (const forbidden of ["set(", "produce(", "reconcileStatuses", "setInterval"])
      expect(hook).not.toContain(forbidden)
  })
})
