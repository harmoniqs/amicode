import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// amicode #1818 — the deprecated research surfaces (system / formulation / run
// / pulse / device entity chips, their entity views, and the home "Now solving"
// + problem-resume readouts) are REMOVED from the app, not wired. The rendered
// DOM absence is pinned by the probe (ops/hub/panel-gate.mjs post-swap); THIS
// suite pins the removal at the source level so the surfaces — and their
// fetches — cannot quietly return with the shipped bundle: the app must not
// read the deprecated routes, and the deprecated view components must not
// exist at all (a deleted module cannot be re-imported by accident).
//
// The LIVE neighbors are deliberately NOT asserted here — receipts (the
// transcript's rendering of live amicode_* tool parts), the ask/approval
// bridges (question inbox + harness control), the in-transcript RunWindow, the
// widget preview, the warrants/approve transport, and the profile / library /
// projects / widgets / dashboard / run-cards reads all stay, pinned by their
// own suites.

const appRoot = join(import.meta.dir, "../..")
const uiAmicode = join(appRoot, "../ui/src/amicode")
const serverAmicode = join(appRoot, "../opencode/src/server/amicode")

const source = (path: string) => readFileSync(path, "utf8")

describe("#1818: home no longer reads the deprecated research routes", () => {
  const home = source(join(appRoot, "src/pages/home.tsx"))

  test("no /amicode/problems read (the deprecated resume-problem feed)", () => {
    expect(home.includes("/amicode/problems")).toBe(false)
  })

  test("no /amicode/problem read (the formulation/system entity reads incl. ?slug=)", () => {
    expect(home.includes("/amicode/problem")).toBe(false)
  })

  test("no /amicode/run-status or /amicode/run-series read (the 'Now solving' polls)", () => {
    expect(home.includes("/amicode/run-status")).toBe(false)
    expect(home.includes("/amicode/run-series")).toBe(false)
  })

  test("no 'Now solving' readout and no entity extraction", () => {
    expect(home.includes("Now solving")).toBe(false)
    expect(home.includes("entities.formulation")).toBe(false)
    expect(home.includes("entities.system")).toBe(false)
  })
})

describe("#1818: the new-session landing no longer reads the problem feed", () => {
  test("session-new-view carries no /amicode/problems read and no resume chip wiring", () => {
    const view = source(join(appRoot, "src/components/session/session-new-view.tsx"))
    expect(view.includes("/amicode/problems")).toBe(false)
    expect(view.includes("resumeProblem")).toBe(false)
    expect(view.includes("AmicodeGettingStarted")).toBe(true) // the landing itself stays live
  })
})

describe("#1818: the session timeline hosts the live bridges but no entity surfaces", () => {
  const timeline = source(join(appRoot, "src/pages/session/timeline/message-timeline.tsx"))

  test("no entity rail mount, no entity-view dialog", () => {
    expect(timeline.includes("AmicodeEntityRail")).toBe(false)
    expect(timeline.includes("AmicodeEntityView")).toBe(false)
    expect(timeline.includes("openEntityView")).toBe(false)
  })

  test("no /amicode/problem or /amicode/run-status fetch (the entity dialog's reads)", () => {
    expect(timeline.includes('"/amicode/problem"')).toBe(false)
    expect(timeline.includes('"/amicode/run-status"')).toBe(false)
  })

  test("the live transports survive: run-series for the RunWindow, warrants for the approval card", () => {
    expect(timeline.includes("/amicode/run-series")).toBe(true)
    expect(timeline.includes('"/amicode/warrants"')).toBe(true)
    expect(timeline.includes('"/amicode/approve"')).toBe(true)
  })
})

describe("#1818: the deprecated view components are deleted, not flagged off", () => {
  const deleted = (path: string) => `ui/src/amicode/${path} still exists`

  test("entity rail + entity view + per-kind views are gone", () => {
    for (const file of [
      "entity-rail.tsx",
      "entity-view.tsx",
      "formulation-view.tsx",
      "system-view.tsx",
      "run-view.tsx",
      "device-view.tsx",
      "calibration-view.tsx",
      "system-render.ts",
      "receipt-currency.ts",
    ]) {
      expect(existsSync(join(uiAmicode, file)), deleted(file)).toBe(false)
    }
  })

  test("their package shims are gone (nothing can import them back)", () => {
    for (const file of [
      "amicode-entity-rail.tsx",
      "amicode-entity-view.tsx",
      "amicode-problem-switcher.tsx",
      "amicode-run-window.tsx",
    ]) {
      expect(existsSync(join(appRoot, "../ui/src/components", file)), `${file} still exists`).toBe(false)
    }
  })

  test("the unmounted device inspector surface is gone (reachable from nothing)", () => {
    expect(existsSync(join(appRoot, "src/amicode/inspector/device-inspector.tsx"))).toBe(false)
  })
})

describe("#1818: shared files keep their live neighbors only", () => {
  test("home-cards: no Now solving / Jump back in / Pulse bank cards, live cards intact", () => {
    const cards = source(join(uiAmicode, "home-cards.tsx"))
    expect(cards.includes("Now solving")).toBe(false)
    expect(cards.includes("Jump back in")).toBe(false)
    expect(cards.includes("Pulse bank")).toBe(false)
    expect(cards.includes("HomeLiveRun")).toBe(false)
    expect(cards.includes("MeetAmicoCard")).toBe(true)
    expect(cards.includes("AboutYouCard")).toBe(true)
    expect(cards.includes("LibraryCard")).toBe(true)
  })

  test("card: receipts render, but no entity view opens from them", () => {
    const card = source(join(uiAmicode, "card.tsx"))
    expect(card.includes("InlineEntityView")).toBe(false)
    expect(card.includes("openAmicodeEntity")).toBe(false)
    expect(card.includes("receiptIsCurrent")).toBe(false)
    // live transcript renderers stay
    expect(card.includes("AmicodeAskCard")).toBe(true)
    expect(card.includes("AmicodeApprovalCard")).toBe(true)
    expect(card.includes("RunWindow")).toBe(true)
    expect(card.includes("WidgetPreviewCard")).toBe(true)
  })

  test("run-window keeps its live series fetch and drops the entity-view click", () => {
    const runWindow = source(join(uiAmicode, "run-window.tsx"))
    expect(runWindow.includes("fetchAmicodeRunSeries")).toBe(true)
    expect(runWindow.includes("openAmicodeEntity")).toBe(false)
  })
})

describe("#1818: the server widget registry ships no deprecated built-in", () => {
  test("the jump-back-in built-in is gone (its feed — context.resume — was killed above)", () => {
    expect(existsSync(join(serverAmicode, "widgets-src/jump-back-in.ts"))).toBe(false)
    const widgets = source(join(serverAmicode, "widgets.ts"))
    expect(widgets.includes("jumpBackIn")).toBe(false)
    expect(widgets.includes("BUILTIN_SOURCES")).toBe(true) // the registry itself stays live
  })
})
