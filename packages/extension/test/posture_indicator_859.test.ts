// S2 (spec-20260907-011500 D2, #859) — the posture indicator's view-model,
// headless under vitest (the #848/#393 pattern: pure + solid-free model, thin
// Solid consumer). Covers: the defensive body parse, the named indicator
// states (absent / quiet / offer), the confirm surface's NEGATIVE path (the
// four affordances), the mixed-shape ask, the read-resolve alias, the
// turn-boundary deferral for plan.auto_switch = auto, the state-preservation
// shape of the switch effect, and the walk-back affordance.
import { describe, expect, test } from "vitest"
import {
  deferredSwitchTick,
  isDirectorPosture,
  postureBodyView,
  postureIndicatorState,
  resolveIndicatorModeId,
  switchDecision,
  switchEffect,
} from "../../app-bundle/overlay/packages/app/src/components/posture-indicator"

const body = (over: Record<string, unknown> = {}) => ({
  ok: true,
  plan: { plan_id: "plan-1", plan_hash: "a".repeat(64), goal: "g", compiled_at: "2026-09-07T10:00:00.000Z" },
  recommendation: { kind: "recommend", mode: "develop", reason: "implementation-shaped plan: implement-slice" },
  auto_switch: "confirm",
  dismissed: false,
  ...over,
})

const recommend = (mode: string) => ({ kind: "recommend", mode, reason: "r" })
const ambiguous = () => ({ kind: "ambiguous", modes: ["develop", "research"], reason: "mixed shape" })

describe("postureBodyView — the defensive parse", () => {
  test("404 / non-object / not-ok → the view does not exist", () => {
    for (const raw of [undefined, null, "nope", [], { ok: false }]) {
      expect(postureBodyView(raw).exists).toBe(false)
    }
  })

  test("a stamped recommendation parses verbatim; auto_switch reads snake_case", () => {
    const v = postureBodyView(body({ auto_switch: "auto" }))
    expect(v.exists).toBe(true)
    expect(v.recommendation).toEqual({ kind: "recommend", mode: "develop", reason: "implementation-shaped plan: implement-slice" })
    expect(v.autoSwitch).toBe("auto")
    expect(v.plan?.planId).toBe("plan-1")
  })

  test("an unstamped (pre-S2) plan reads recommendation null — never re-derived", () => {
    expect(postureBodyView(body({ recommendation: null })).recommendation).toBeNull()
    expect(postureBodyView(body({ recommendation: undefined })).recommendation).toBeNull()
  })

  test("off-shape recommendations never parse into a guess", () => {
    for (const bad of [
      { kind: "recommend", mode: "plan", reason: "r" },
      { kind: "recommend", mode: "develop" },
      { kind: "ambiguous", modes: ["develop"], reason: "r" },
      { kind: "unknown", reason: "r" },
      "develop",
    ]) {
      expect(postureBodyView(body({ recommendation: bad })).recommendation).toBeNull()
    }
  })

  test("a corrupt auto_switch fails safe to confirm", () => {
    expect(postureBodyView(body({ auto_switch: "silently" })).autoSwitch).toBe("confirm")
  })
})

describe("postureIndicatorState — named states", () => {
  test("absent when the route/body does not exist", () => {
    expect(postureIndicatorState({ body: undefined, currentAgent: "plan" }).state).toBe("absent")
    expect(postureIndicatorState({ body: postureBodyView(null), currentAgent: "plan" }).state).toBe("absent")
  })

  test("quiet when there is no plan or no stamped recommendation", () => {
    expect(postureIndicatorState({ body: postureBodyView(body({ plan: null, recommendation: null })), currentAgent: "plan" })).toEqual({
      state: "quiet",
      current: "plan",
      walkBack: false,
    })
    expect(postureIndicatorState({ body: postureBodyView(body({ recommendation: { kind: "none", reason: "no terminal execution artifact" } })), currentAgent: "plan" }).state).toBe("quiet")
  })

  test("the offer fires for a live recommendation targeting a different posture", () => {
    const s = postureIndicatorState({ body: postureBodyView(body()), currentAgent: "plan" })
    expect(s.state).toBe("offer")
    if (s.state !== "offer") return
    expect(s.affordances.targets).toEqual(["develop", "research"]) // confirm + wrong—actually <other>
    expect(s.affordances.dismiss).toBe(true)
    expect(s.affordances.stay).toBe(true)
  })

  test("no offer when the recommendation already names the current posture", () => {
    expect(postureIndicatorState({ body: postureBodyView(body({ recommendation: recommend("develop") })), currentAgent: "develop" }).state).toBe("quiet")
  })

  test("a dismissed recommendation is ambient again — quiet, never nagging", () => {
    expect(postureIndicatorState({ body: postureBodyView(body({ dismissed: true })), currentAgent: "plan" }).state).toBe("quiet")
  })

  test("MIXED shape → the offer names BOTH modes as buttons — the user picks", () => {
    const s = postureIndicatorState({ body: postureBodyView(body({ recommendation: ambiguous() })), currentAgent: "plan" })
    expect(s.state).toBe("offer")
    if (s.state !== "offer") return
    expect(s.affordances.targets.sort()).toEqual(["develop", "research"])
  })

  test("the walk-back: a director posture carries it ambient; plan does not", () => {
    expect(postureIndicatorState({ body: postureBodyView(body({ recommendation: null })), currentAgent: "develop" })).toEqual({
      state: "quiet",
      current: "develop",
      walkBack: true,
    })
    expect(postureIndicatorState({ body: postureBodyView(body({ recommendation: null })), currentAgent: "plan" }).walkBack).toBe(false)
  })
})

describe("read-resolve alias (the indicator side)", () => {
  test("old director ids resolve at read time", () => {
    expect(resolveIndicatorModeId("autodev")).toBe("develop")
    expect(resolveIndicatorModeId("autoresearch")).toBe("research")
    expect(resolveIndicatorModeId("build")).toBe("build")
  })

  test("a persisted selection carrying autodev + a develop offer → quiet (already there)", () => {
    expect(postureIndicatorState({ body: postureBodyView(body()), currentAgent: "autodev" }).state).toBe("quiet")
  })

  test("isDirectorPosture resolves through the alias", () => {
    expect(isDirectorPosture("autoresearch")).toBe(true)
    expect(isDirectorPosture("plan")).toBe(false)
  })
})

describe("switch mechanics — plan.auto_switch", () => {
  test("confirm (default) fires immediately on click", () => {
    expect(switchDecision({ target: "develop", autoSwitch: "confirm", statusType: "busy" })).toEqual({ defer: false, target: "develop" })
  })

  test("auto defers to the turn boundary while the session is mid-generation", () => {
    expect(switchDecision({ target: "research", autoSwitch: "auto", statusType: "busy" })).toEqual({ defer: true, target: "research" })
    expect(switchDecision({ target: "research", autoSwitch: "auto", statusType: "idle" })).toEqual({ defer: false, target: "research" })
    // no open session (home surface) — idle by definition
    expect(switchDecision({ target: "research", autoSwitch: "auto", statusType: undefined })).toEqual({ defer: false, target: "research" })
  })

  test("the deferred switch fires at the turn boundary and drops when superseded", () => {
    const pending = { target: "develop" as const, planHash: "a".repeat(64) }
    expect(deferredSwitchTick({ pending, statusType: "busy", latestPlanHash: "a".repeat(64) })).toEqual({ action: "wait" })
    expect(deferredSwitchTick({ pending, statusType: "idle", latestPlanHash: "a".repeat(64) })).toEqual({ action: "fire", target: "develop" })
    expect(deferredSwitchTick({ pending, statusType: "idle", latestPlanHash: "b".repeat(64) })).toEqual({ action: "drop" })
    // a body that carried no plan hash cannot prove supersession — the wait holds
    expect(deferredSwitchTick({ pending, statusType: "idle", latestPlanHash: undefined })).toEqual({ action: "fire", target: "develop" })
  })
})

describe("state preservation — the switch mutates ONLY the agent binding", () => {
  test("the effect carries the agent + the additive session-record write, nothing else", () => {
    const e = switchEffect("develop")
    expect(Object.keys(e).sort()).toEqual(["agent", "sessionRecord"])
    expect(e.sessionRecord).toEqual({ amicode_posture: { mode: "develop", source: "posture-indicator" } })
  })
})
