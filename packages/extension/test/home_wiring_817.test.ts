// Issue #817 — home wiring: the honest states reach the home page and every
// session home is first-class in the all-projects scope. Source-pinned per
// the repo's overlay-wiring idiom (the home controllers are Solid components);
// the behavioral cores are exercised in home_session_groups_817.test.ts and
// session_list_state_817.test.ts.
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const overlay = (...p: string[]) => join(__dirname, "../../app-bundle/overlay/packages/app/src", ...p)
const src = (p: string) => readFileSync(overlay(p), "utf8")

describe("home page honest states (D2)", () => {
  test("the controller exposes listState from the index query's success", () => {
    const s = src("pages/home/home-sessions-controller.tsx")
    expect(s).toMatch(/listState: \(\) =>\s*\n?\s*sessionListState\(\{\s*\n?\s*fetched: sessionLoad\.isSuccess,/)
  })

  test("the glue threads listState into the view", () => {
    expect(src("pages/home/home-sessions.tsx")).toContain("listState={props.sessions.data.listState}")
  })

  test("the view renders loading — never the empty state — while unfetched", () => {
    const s = src("pages/home/home-sessions-view.tsx")
    expect(s).toMatch(/props\.groups\(\)\.length > 0 \|\| props\.listState\(\) === "unfetched"/)
    expect(s).toMatch(/when=\{props\.listState\(\) !== "unfetched"\}/)
  })
})

describe("client-side grouping (D1: no home dropped, no server rows)", () => {
  test("the controller resolves records through the pure first-class module", () => {
    const s = src("pages/home/home-sessions-controller.tsx")
    expect(s).toContain('from "./home-session-groups"')
    expect(s).toMatch(/scopeAll: !home\.project\.selected\(\)/)
  })

  test("the controller no longer drops sessions whose project cannot be resolved", () => {
    const s = src("pages/home/home-sessions-controller.tsx")
    // The old controller ended its record builder with `if (!project) return []`
    // — the invisible-group incident's client-side shape. The carried builder
    // synthesizes a home instead.
    expect(s).not.toMatch(/if \(!project\) return \[\]/)
  })
})
