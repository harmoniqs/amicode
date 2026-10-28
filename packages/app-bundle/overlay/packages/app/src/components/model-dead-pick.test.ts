// amicode#1989 (#1979 S6): fail fast on a dead pick — pure rules, pinned
// without mounting the composer: which real failures demote, which do not,
// and which model the warning offers to switch to.
import { describe, expect, test } from "bun:test"
import type { ReachabilitySnapshot } from "./dialog-select-model-reachability"
import {
  applyTurnFailure,
  classifyTurnError,
  deadPickWarning,
  demoteRequest,
  latestTurnFailure,
  recommendedSwitchTargets,
  shouldDemote,
  createDemoteGate,
  type DeadPickCandidate,
} from "./model-dead-pick"

const T0 = 1_700_000_000_000

const row = (
  provider: string,
  model: string,
  status: string,
  opts: { reason?: string | null; at?: number; source?: "probe" | "demoted" } = {},
) => ({
  provider,
  model,
  status: status as ReachabilitySnapshot["models"][number]["status"],
  reason: opts.reason ?? null,
  latency_ms: 10,
  checked_at: opts.at ?? T0,
  credential_fp: "fp1",
  source: opts.source ?? ("probe" as const),
})

const snap = (...models: ReturnType<typeof row>[]): ReachabilitySnapshot => ({
  catalog_known: true,
  models,
  providers: [],
})

const apiError = (statusCode: number | undefined, message: string, extra: Record<string, unknown> = {}) => ({
  name: "APIError",
  data: { message, statusCode, isRetryable: false, ...extra },
})

describe("classifyTurnError — what a real failure demotes", () => {
  test("Bedrock AccessDenied (403) → denied", () => {
    const got = classifyTurnError(
      apiError(403, "User: arn:aws:iam::123:user/x is not authorized to perform: bedrock:InvokeModel", {
        responseHeaders: { "x-amzn-ErrorType": "AccessDeniedException:http://internal.amazon.com/" },
      }),
    )
    expect(got?.status).toBe("denied")
    expect(got?.reason).toContain("not authorized")
  })

  test("401 → denied; ProviderAuthError → denied", () => {
    expect(classifyTurnError(apiError(401, "Invalid API key"))?.status).toBe("denied")
    expect(
      classifyTurnError({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "bad key" } })?.status,
    ).toBe("denied")
  })

  test("marketplace / not available for this account → unavailable", () => {
    expect(
      classifyTurnError(apiError(400, "Model access is denied due to missing AWS Marketplace subscription"))?.status,
    ).toBe("unavailable")
    expect(classifyTurnError(apiError(400, "This model is not available for this account."))?.status).toBe(
      "unavailable",
    )
  })

  test("ValidationException / 404 / unknown model → invalid", () => {
    expect(
      classifyTurnError(
        apiError(400, "Invocation of model ID x with on-demand throughput isn't supported. Use an inference profile."),
      )?.status,
    ).toBe("invalid")
    expect(classifyTurnError(apiError(404, "Not Found"))?.status).toBe("invalid")
    expect(classifyTurnError({ name: "UnknownError", data: { message: "ProviderModelNotFoundError: no such model" } })?.status).toBe(
      "invalid",
    )
  })

  test("transient failures do NOT demote", () => {
    // rate limit — by status and by text (Bedrock ThrottlingException)
    expect(classifyTurnError(apiError(429, "Too many requests"))).toBeNull()
    expect(classifyTurnError(apiError(400, "ThrottlingException: Too many tokens, please wait"))).toBeNull()
    // TLS / network
    expect(
      classifyTurnError({
        name: "UnknownError",
        data: {
          message:
            "ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match certificate's altnames: Host: bedrock.example is not in the cert's altnames",
        },
      }),
    ).toBeNull()
    expect(classifyTurnError({ name: "UnknownError", data: { message: "fetch failed: ECONNRESET" } })).toBeNull()
    expect(classifyTurnError(apiError(undefined, "getaddrinfo ENOTFOUND api.example.com"))).toBeNull()
    // timeouts
    expect(classifyTurnError({ name: "UnknownError", data: { message: "TimeoutError: The operation timed out." } })).toBeNull()
    expect(classifyTurnError(apiError(408, "Request Timeout"))).toBeNull()
    // 5xx — even with a denial-looking body, a server error is not a verdict
    expect(classifyTurnError(apiError(503, "Service Unavailable"))).toBeNull()
    expect(classifyTurnError(apiError(500, "Internal error: access denied to upstream cache"))).toBeNull()
  })

  test("non-reachability errors do NOT demote", () => {
    expect(classifyTurnError({ name: "MessageAbortedError", data: { message: "aborted" } })).toBeNull()
    expect(classifyTurnError({ name: "ContextOverflowError", data: { message: "prompt is too long" } })).toBeNull()
    expect(classifyTurnError({ name: "MessageOutputLengthError", data: {} })).toBeNull()
    expect(classifyTurnError(apiError(400, "messages: text content blocks must be non-empty"))).toBeNull()
    expect(classifyTurnError(undefined)).toBeNull()
    expect(classifyTurnError("boom")).toBeNull()
  })
})

const assistant = (id: string, providerID: string, modelID: string, error?: unknown, at = T0 + 1000) => ({
  id,
  role: "assistant",
  providerID,
  modelID,
  time: { created: at, completed: at + 5 },
  ...(error ? { error } : {}),
})

describe("latestTurnFailure — only the session's latest assistant turn counts", () => {
  test("a denied latest turn yields the failed model + status", () => {
    const got = latestTurnFailure([
      { id: "u1", role: "user", time: { created: T0 } },
      assistant("a1", "amazon-bedrock", "anthropic.claude-x", apiError(403, "AccessDeniedException")),
    ])
    expect(got).toMatchObject({
      messageID: "a1",
      ref: { providerID: "amazon-bedrock", modelID: "anthropic.claude-x" },
      status: "denied",
      at: T0 + 1005,
    })
  })

  test("an earlier failure followed by a good turn is history, not a dead pick", () => {
    expect(
      latestTurnFailure([
        assistant("a1", "p", "m", apiError(403, "Forbidden")),
        assistant("a2", "p", "m", undefined, T0 + 2000),
      ]),
    ).toBeUndefined()
  })

  test("a transient latest failure yields nothing", () => {
    expect(latestTurnFailure([assistant("a1", "p", "m", apiError(429, "rate limit"))])).toBeUndefined()
    expect(latestTurnFailure([])).toBeUndefined()
  })
})

describe("shouldDemote / applyTurnFailure — a fresher probe wins", () => {
  const failure = {
    messageID: "a1",
    ref: { providerID: "p", modelID: "m" },
    status: "denied" as const,
    reason: "AccessDenied",
    at: T0 + 1000,
  }

  test("demotes when the cached row is ok from an older probe (or absent)", () => {
    expect(shouldDemote(failure, snap(row("p", "m", "ok", { at: T0 })))).toBe(true)
    expect(shouldDemote(failure, snap())).toBe(true)
    expect(shouldDemote(failure, undefined)).toBe(true)
  })

  test("does not demote over a probe newer than the failure, nor re-demote the same status", () => {
    expect(shouldDemote(failure, snap(row("p", "m", "ok", { at: T0 + 5000 })))).toBe(false)
    expect(shouldDemote(failure, snap(row("p", "m", "denied", { at: T0, source: "demoted" })))).toBe(false)
  })

  test("applyTurnFailure overlays the demotion locally (never silent, even if the POST fails)", () => {
    const base = snap(row("p", "m", "ok", { at: T0 }), row("p", "other", "ok"))
    const got = applyTurnFailure(base, failure)
    expect(got?.models.find((m) => m.model === "m")).toMatchObject({ status: "denied", source: "demoted" })
    expect(got?.models.find((m) => m.model === "other")?.status).toBe("ok")
    // no snapshot (passthrough host) still yields a one-row snapshot
    expect(applyTurnFailure(undefined, failure)?.models).toHaveLength(1)
    // a fresher probe keeps the snapshot as is
    const fresh = snap(row("p", "m", "ok", { at: T0 + 5000 }))
    expect(applyTurnFailure(fresh, failure)).toBe(fresh)
    expect(applyTurnFailure(base, undefined)).toBe(base)
  })

  test("demoteRequest is the S2 route body", () => {
    expect(demoteRequest(failure)).toEqual({ provider: "p", model: "m", status: "denied", reason: "AccessDenied" })
  })

  test("createDemoteGate: once per model per session", () => {
    const gate = createDemoteGate()
    expect(gate.claim("s1", { providerID: "p", modelID: "m" })).toBe(true)
    expect(gate.claim("s1", { providerID: "p", modelID: "m" })).toBe(false)
    expect(gate.claim("s2", { providerID: "p", modelID: "m" })).toBe(true)
    expect(gate.claim("s1", { providerID: "p", modelID: "m2" })).toBe(true)
  })
})

const cand = (providerID: string, modelID: string, input?: number, output?: number): DeadPickCandidate => ({
  providerID,
  modelID,
  ...(input !== undefined ? { cost: { input, output: output ?? 0 } } : {}),
})

describe("deadPickWarning — the named warning and its switch target", () => {
  const current = { providerID: "bedrock", modelID: "dead" }
  const candidates = [
    cand("bedrock", "dead", 1, 1),
    cand("bedrock", "pricey", 15, 75),
    cand("bedrock", "cheap", 1, 5),
    cand("bedrock", "unknown-cost"),
    cand("anthropic", "cheapest", 0.1, 0.1),
    cand("anthropic", "rec", 3, 15),
  ]

  test("no warning when the current model is ok, unchecked, rate-limited, or unknown", () => {
    for (const status of ["ok", "unchecked", "rate-limited"])
      expect(
        deadPickWarning({ current, snapshot: snap(row("bedrock", "dead", status)), candidates }),
      ).toBeUndefined()
    expect(deadPickWarning({ current, snapshot: snap(), candidates })).toBeUndefined()
    expect(deadPickWarning({ current, snapshot: undefined, candidates })).toBeUndefined()
    expect(deadPickWarning({ current: undefined, snapshot: snap(), candidates })).toBeUndefined()
  })

  test("a dead current model warns with its named reason", () => {
    const got = deadPickWarning({
      current,
      snapshot: snap(row("bedrock", "dead", "unavailable"), row("bedrock", "cheap", "ok")),
      candidates,
    })
    expect(got?.model).toEqual(current)
    expect(got?.status).toBe("unavailable")
    expect(got?.reason).toEqual({ key: "dialog.model.reachability.reason.unavailable" })
    // an error row carries its own (redacted) text
    const err = deadPickWarning({ current, snapshot: snap(row("bedrock", "dead", "error", { reason: "boom" })), candidates })
    expect(err?.reason).toEqual({ text: "boom" })
  })

  test("recommended first: the first ok recommended model wins", () => {
    const got = deadPickWarning({
      current,
      snapshot: snap(
        row("bedrock", "dead", "denied"),
        row("bedrock", "cheap", "ok"),
        row("anthropic", "rec", "ok"),
        row("bedrock", "pricey", "denied"),
      ),
      candidates,
      recommended: [{ providerID: "bedrock", modelID: "pricey" }, current, { providerID: "anthropic", modelID: "rec" }],
    })
    expect(got?.switchTo).toEqual({ providerID: "anthropic", modelID: "rec" })
  })

  test("no (usable) recommended: cheapest-known ok model of the same provider", () => {
    const snapshot = snap(
      row("bedrock", "dead", "denied"),
      row("bedrock", "pricey", "ok"),
      row("bedrock", "cheap", "ok"),
      row("bedrock", "unknown-cost", "ok"),
      row("anthropic", "cheapest", "ok"),
    )
    expect(deadPickWarning({ current, snapshot, candidates, recommended: [] })?.switchTo).toEqual({
      providerID: "bedrock",
      modelID: "cheap",
    })
    // a recommended model that is not ok falls through to the same rule
    expect(
      deadPickWarning({ current, snapshot, candidates, recommended: [{ providerID: "anthropic", modelID: "rec" }] })
        ?.switchTo,
    ).toEqual({ providerID: "bedrock", modelID: "cheap" })
  })

  test("same provider has only unknown-cost ok models → one of them, still same provider", () => {
    const snapshot = snap(row("bedrock", "dead", "denied"), row("bedrock", "unknown-cost", "ok"), row("anthropic", "cheapest", "ok"))
    expect(deadPickWarning({ current, snapshot, candidates })?.switchTo).toEqual({
      providerID: "bedrock",
      modelID: "unknown-cost",
    })
  })

  test("no ok model on the same provider → cheapest ok model anywhere", () => {
    const snapshot = snap(
      row("bedrock", "dead", "denied"),
      row("bedrock", "cheap", "rate-limited"),
      row("anthropic", "rec", "ok"),
      row("anthropic", "cheapest", "ok"),
    )
    expect(deadPickWarning({ current, snapshot, candidates })?.switchTo).toEqual({
      providerID: "anthropic",
      modelID: "cheapest",
    })
  })

  test("ok rows that are not selectable candidates are never offered", () => {
    const snapshot = snap(row("bedrock", "dead", "denied"), row("disconnected", "x", "ok"))
    expect(deadPickWarning({ current, snapshot, candidates })?.switchTo).toBeUndefined()
  })

  test("no ok models at all → warning without a switch offer", () => {
    const got = deadPickWarning({
      current,
      snapshot: snap(row("bedrock", "dead", "invalid"), row("bedrock", "cheap", "denied"), row("anthropic", "rec", "unchecked")),
      candidates,
      recommended: [{ providerID: "anthropic", modelID: "rec" }],
    })
    expect(got).toBeDefined()
    expect(got?.status).toBe("invalid")
    expect(got?.switchTo).toBeUndefined()
  })
})

// amicode#1988 (#1979 S5): the S6 follow-up — the S4 deployment config's
// recommended list feeds the switch target.
describe("recommendedSwitchTargets — S4 config → dead-pick recommended (#1988)", () => {
  const ref = (providerID: string, modelID: string) => ({ providerID, modelID })

  test("no config → none (the cheapest-ok fallback rules)", () => {
    expect(recommendedSwitchTargets(undefined)).toEqual([])
    expect(recommendedSwitchTargets({ recommended: [], allowlist: undefined })).toEqual([])
  })

  test("in role order (default, fast, strong, open-weight), config order within a role, deduped", () => {
    expect(
      recommendedSwitchTargets({
        recommended: [
          { ref: ref("a", "strong"), role: "strong" },
          { ref: ref("a", "fast"), role: "fast" },
          { ref: ref("a", "default-1"), role: "default" },
          { ref: ref("a", "default-2"), role: "default" },
          { ref: ref("a", "fast"), role: "strong" },
        ],
        allowlist: undefined,
      }),
    ).toEqual([ref("a", "default-1"), ref("a", "default-2"), ref("a", "fast"), ref("a", "strong")])
  })

  test("the allowlist hard-filters the switch targets too", () => {
    expect(
      recommendedSwitchTargets({
        recommended: [
          { ref: ref("a", "x"), role: "default" },
          { ref: ref("b", "y"), role: "default" },
        ],
        allowlist: ["b/*"],
      }),
    ).toEqual([ref("b", "y")])
  })

  test("the switch prefers a recommended ok model over a cheaper same-provider one", () => {
    const current = ref("bedrock", "dead")
    const candidates = [cand("bedrock", "dead", 1, 1), cand("bedrock", "cheap", 1, 5), cand("anthropic", "rec", 3, 15)]
    const snapshot = snap(row("bedrock", "dead", "denied"), row("bedrock", "cheap", "ok"), row("anthropic", "rec", "ok"))
    const recommended = recommendedSwitchTargets({
      recommended: [{ ref: ref("anthropic", "rec"), role: "default" }],
      allowlist: undefined,
    })
    expect(deadPickWarning({ current, snapshot, candidates, recommended })?.switchTo).toEqual(ref("anthropic", "rec"))
    // without the config the same snapshot falls back to the cheapest same-provider model
    expect(
      deadPickWarning({ current, snapshot, candidates, recommended: recommendedSwitchTargets(undefined) })?.switchTo,
    ).toEqual(ref("bedrock", "cheap"))
  })
})
