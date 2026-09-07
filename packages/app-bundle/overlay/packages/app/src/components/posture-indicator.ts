// POSTURE INDICATOR — view-model (S2, spec-20260907-011500 D2, #859).
//
// The posture indicator is the plan-exit confirm surface, first-class (the
// fork's #297 slice b intent, ported to the app overlay — composed on the
// EXISTING committed surfaces: the /amicode/* raw routes and the app's own
// agent binding, never a new engine contract).
//
// THE DATA CROSSING (the doctrine's litmus): the recommendation is read from
// the /amicode/posture route, which serves the STAMPED posture_recommendation
// off the compiled plan artifact. This view-model NEVER re-derives a
// recommendation and never keyword-guesses — an unstamped plan reads null and
// the offer stays quiet.
//
// THE CONFIRM SURFACE carries the NEGATIVE path (spec D2 fold), one click
// each: confirm / dismiss / wrong—actually <other mode> / stay in plan. A
// MIXED-shape recommendation (kind "ambiguous") names BOTH modes — the user
// picks; no silent coin-flip.
//
// plan.auto_switch = confirm | auto (default confirm): `confirm` switches on
// click; `auto` defers to the TURN BOUNDARY (never mid-generation), announces
// the switch, and preserves state — the switch carries ONLY the agent
// binding, so the session, its draft, and its pending questions ride along
// untouched (never dropped at re-bind).
//
// BIDIRECTIONAL (D2): with the current posture in develop/research, the
// collapsed indicator carries the walk-back-to-plan affordance.
//
// Pure and solid-free so it unit-tests headless; posture-indicator-view.tsx
// is the thin Solid consumer.

// ── the mode-id read-resolve alias (spec D1, #858) — parity with
// context/local-agent.ts: a persisted selection carrying an old director id
// resolves to the renamed posture at read time. Duplicated by the overlay
// contract; kept in step by construction (local-agent.ts owns the picker
// side, this owns the indicator side). ──
const MODE_ID_ALIASES: Record<string, string> = {
  autodev: "develop",
  autoresearch: "research",
}

export function resolveIndicatorModeId(id: string): string {
  return MODE_ID_ALIASES[id] ?? id
}

export type IndicatorPostureMode = "develop" | "research"
export type IndicatorPlanMode = "plan" | "develop" | "research" | "build" | (string & {})

export interface PosturePlanView {
  planId: string | null
  planHash: string | null
  goal: string | null
  compiledAt: string | null
}

export type PostureRecommendationView =
  | { kind: "recommend"; mode: IndicatorPostureMode; reason: string }
  | { kind: "ambiguous"; modes: IndicatorPostureMode[]; reason: string }
  | { kind: "none"; reason: string }

export interface PostureBodyView {
  /** The staged route exists. A 404 (route not mounted — older extension) or
   *  any non-ok body means the view does not exist: render NOTHING, never a
   *  guess. */
  exists: boolean
  plan: PosturePlanView | null
  /** The STAMPED recommendation, verbatim. null when the plan carries no
   *  stamp (pre-S2 compile) or the field is off-shape — never re-derived. */
  recommendation: PostureRecommendationView | null
  autoSwitch: "confirm" | "auto"
  dismissed: boolean
}

export interface PostureAffordances {
  /** One per SWITCHABLE mode — for kind "recommend" a single target (the
   *  confirmed posture); "wrong—actually <other>" is the OTHER mode as a
   *  first-class button; for "ambiguous" BOTH modes are buttons (the user
   *  picks). */
  targets: IndicatorPostureMode[]
  dismiss: boolean
  stay: boolean
}

const POSTURE_MODES = new Set(["develop", "research"])
const DIRECTOR_POSTURES = new Set(["develop", "research"])

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function recommendationView(raw: unknown): PostureRecommendationView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const kind = str(r["kind"])
  if (kind === "recommend") {
    const mode = str(r["mode"])
    const reason = str(r["reason"])
    if (mode === null || !POSTURE_MODES.has(mode) || reason === null) return null
    return { kind: "recommend", mode: mode as IndicatorPostureMode, reason }
  }
  if (kind === "ambiguous") {
    const modes = Array.isArray(r["modes"]) ? r["modes"].filter((m): m is IndicatorPostureMode => typeof m === "string" && POSTURE_MODES.has(m)) : []
    const reason = str(r["reason"])
    if (modes.length !== 2 || reason === null) return null
    return { kind: "ambiguous", modes, reason }
  }
  if (kind === "none") {
    const reason = str(r["reason"])
    if (reason === null) return null
    return { kind: "none", reason }
  }
  return null
}

/** Parse the GET /amicode/posture body defensively. A 404'd probe
 *  (undefined — an extension without the route), a non-object body, or a
 *  body without ok all mean the view does not exist. Never throws. */
export function postureBodyView(raw: unknown): PostureBodyView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ABSENT
  const body = raw as Record<string, unknown>
  if (body["ok"] !== true) return ABSENT
  const rawPlan = typeof body["plan"] === "object" && body["plan"] !== null ? (body["plan"] as Record<string, unknown>) : null
  const autoSwitch = body["autoSwitch"] ?? body["auto_switch"]
  return {
    exists: true,
    plan:
      rawPlan === null
        ? null
        : {
            planId: str(rawPlan["plan_id"]),
            planHash: str(rawPlan["plan_hash"]),
            goal: str(rawPlan["goal"]),
            compiledAt: str(rawPlan["compiled_at"]),
          },
    recommendation: recommendationView(body["recommendation"]),
    autoSwitch: autoSwitch === "auto" ? "auto" : "confirm",
    dismissed: body["dismissed"] === true,
  }
}

const ABSENT: PostureBodyView = { exists: false, plan: null, recommendation: null, autoSwitch: "confirm", dismissed: false }

// ── the indicator state (the single decision the view renders from) ─────────

export type PostureIndicatorState =
  /** The route does not exist (older extension / fetch failed): render
   *  nothing — ambient-when-ignored means never a dead widget. */
  | { state: "absent" }
  /** Collapsed, quiet: the current posture (and, in a director posture, the
   *  walk-back affordance on click). */
  | { state: "quiet"; current: IndicatorPlanMode; walkBack: boolean }
  /** The offer: the recommendation banner with the affordance set. */
  | { state: "offer"; current: IndicatorPlanMode; recommendation: PostureRecommendationView; affordances: PostureAffordances }

/** The indicator's presentation state. `current` is the session's (or the
 *  draft's) bound agent id, read-resolved. Never throws; every input
 *  combination resolves to a named state. */
export function postureIndicatorState(input: { body: PostureBodyView | undefined; currentAgent: string | undefined }): PostureIndicatorState {
  const body = input.body
  if (body === undefined || !body.exists) return { state: "absent" }
  const current = resolveIndicatorModeId(input.currentAgent ?? "plan")
  const rec = body.recommendation
  if (rec === null || rec.kind === "none" || body.dismissed)
    return { state: "quiet", current, walkBack: DIRECTOR_POSTURES.has(current) }
  // kind "recommend" already naming the current posture is nothing to offer.
  if (rec.kind === "recommend" && rec.mode === current)
    return { state: "quiet", current, walkBack: DIRECTOR_POSTURES.has(current) }
  const targets: IndicatorPostureMode[] =
    rec.kind === "recommend"
      ? // confirm = the recommended mode; wrong—actually <other> = the other of the pair
        rec.mode === "develop"
        ? ["develop", "research"]
        : ["research", "develop"]
      : [...rec.modes]
  return {
    state: "offer",
    current,
    recommendation: rec,
    affordances: { targets, dismiss: true, stay: true },
  }
}

// ── the switching mechanics (the Tab-switch contract, made product) ─────────

export type SwitchDecision =
  /** confirm (default): switch NOW — the click re-binds the agent; the next
   *  prompt carries the new posture's card (the Tab-switch contract). The
   *  target is an AGENT ID: a posture mode, or "plan" (the walk-back). */
  | { defer: false; target: string }
  /** auto + mid-generation: defer to the TURN BOUNDARY — never switch under
   *  an in-flight turn. */
  | { defer: true; target: string }

/** Decide whether a switch fires immediately or defers to the turn boundary.
 *  `confirm` (the default) always fires on click; `auto` defers while the
 *  session is mid-generation (statusType anything but "idle"; undefined —
 *  e.g. on the home surface, no open session — is idle by definition). */
export function switchDecision(input: {
  target: string
  autoSwitch: "confirm" | "auto"
  statusType: string | undefined
}): SwitchDecision {
  const busy = input.autoSwitch === "auto" && input.statusType !== undefined && input.statusType !== "idle"
  return busy ? { defer: true, target: input.target } : { defer: false, target: input.target }
}

/** The deferred switch's turn-boundary tick. "fire" when the session went
 *  idle with a pending target; "wait" while the generation runs; "drop" when
 *  the recommendation was superseded (a NEWER plan compiled since the switch
 *  was queued — the stale offer must not fire). */
export function deferredSwitchTick(input: {
  pending: { target: string; planHash: string | null } | undefined
  statusType: string | undefined
  latestPlanHash: string | null | undefined
}): { action: "wait" | "fire" | "drop"; target?: string } {
  const pending = input.pending
  if (pending === undefined) return { action: "wait" }
  if (input.latestPlanHash !== undefined && pending.planHash !== null && input.latestPlanHash !== pending.planHash)
    return { action: "drop" }
  if (input.statusType === undefined || input.statusType === "idle") return { action: "fire", target: pending.target }
  return { action: "wait" }
}

/** What a switch mutates: ONLY the agent binding. The state-preservation
 *  requirement (spec D2 fold) is structural — the switch action carries no
 *  draft, no session, no prompt mutation, so the plan's open draft and
 *  pending questions ride along by construction. The session record write
 *  (ADR-0011 vNext metadata) is ADDITIVE data alongside the binding, never a
 *  replacement of it. */
export interface SwitchEffect {
  agent: string
  sessionRecord: { amicode_posture: { mode: string; source: "posture-indicator" } }
}

export function switchEffect(target: string): SwitchEffect {
  return {
    agent: target,
    sessionRecord: { amicode_posture: { mode: target, source: "posture-indicator" } },
  }
}

export function isDirectorPosture(mode: string): boolean {
  return DIRECTOR_POSTURES.has(resolveIndicatorModeId(mode))
}
