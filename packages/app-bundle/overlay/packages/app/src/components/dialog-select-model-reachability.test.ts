// amicode#1986 (#1979 S3): the picker's reachability merge — pure, so the
// visible-set rules are pinned without mounting the SolidJS picker.
import { describe, expect, test } from "bun:test"
import {
  parseReachabilityResponse,
  partitionByReachability,
  reachabilityReason,
  type ReachabilitySnapshot,
} from "./dialog-select-model-reachability"

type Item = { id: string; provider: { id: string } }
const item = (provider: string, id: string): Item => ({ id, provider: { id: provider } })
const keyOf = (x: Item) => ({ providerID: x.provider.id, modelID: x.id })
const ids = (xs: Item[]) => xs.map((x) => `${x.provider.id}:${x.id}`)

const row = (provider: string, model: string, status: string, reason: string | null = null) => ({
  provider,
  model,
  status,
  reason,
  latency_ms: status === "unchecked" ? null : 12,
  checked_at: status === "unchecked" ? null : 1_700_000_000_000,
  credential_fp: "fp1",
  source: status === "unchecked" ? null : "probe",
})
const prov = (provider: string, probed: boolean) => ({
  provider,
  credential_fp: probed ? "fp1" : null,
  last_probe_at: probed ? 1_700_000_000_000 : null,
  last_attempt_at: probed ? 1_700_000_000_000 : null,
  last_error: null,
  next_probe_at: null,
})
const response = (models: unknown[], providers: unknown[]) => ({
  ok: true,
  error: null,
  catalog_known: true,
  models,
  providers,
})

const items = [
  item("bedrock", "claude-ok"),
  item("bedrock", "claude-denied"),
  item("bedrock", "claude-unavailable"),
  item("bedrock", "claude-unchecked"),
  item("bedrock", "claude-invalid"),
  item("bedrock", "claude-error"),
  item("bedrock", "claude-ratelimited"),
  item("bedrock", "claude-norow"),
]
const mixed = parseReachabilityResponse(
  response(
    [
      row("bedrock", "claude-ok", "ok"),
      row("bedrock", "claude-denied", "denied", "AccessDeniedException"),
      row("bedrock", "claude-unavailable", "unavailable"),
      row("bedrock", "claude-unchecked", "unchecked"),
      row("bedrock", "claude-invalid", "invalid"),
      row("bedrock", "claude-error", "error", "socket hang up"),
      row("bedrock", "claude-ratelimited", "rate-limited"),
    ],
    [prov("bedrock", true)],
  ),
) as ReachabilitySnapshot

describe("parseReachabilityResponse", () => {
  test("a well-formed S2 body parses to a snapshot", () => {
    expect(mixed).toBeDefined()
    expect(mixed.models.length).toBe(7)
  })

  test("route unavailable / malformed / ok:false → undefined (passthrough)", () => {
    expect(parseReachabilityResponse(undefined)).toBeUndefined()
    expect(parseReachabilityResponse("nope")).toBeUndefined()
    expect(parseReachabilityResponse({ ok: false, error: "cache_unavailable: x" })).toBeUndefined()
    expect(parseReachabilityResponse({ ok: true, models: "x" })).toBeUndefined()
  })

  test("rows with an unknown status are dropped, not trusted", () => {
    const snap = parseReachabilityResponse(response([row("a", "m", "ok"), row("a", "n", "great")], []))
    expect(snap?.models.map((m) => m.model)).toEqual(["m"])
  })
})

describe("partitionByReachability", () => {
  test("ok + rate-limited show by default; dead and probed-provider unchecked hide", () => {
    const p = partitionByReachability(items, keyOf, mixed)
    expect(ids(p.shown)).toEqual(["bedrock:claude-ok", "bedrock:claude-ratelimited"])
    expect(ids(p.hidden)).toEqual([
      "bedrock:claude-denied",
      "bedrock:claude-unavailable",
      "bedrock:claude-unchecked",
      "bedrock:claude-invalid",
      "bedrock:claude-error",
      "bedrock:claude-norow",
    ])
    expect(p.hiddenCount).toBe(6)
  })

  test("the toggle reveals hidden models greyed, with human reasons", () => {
    const p = partitionByReachability(items, keyOf, mixed)
    expect(ids(p.list(false))).toEqual(ids(p.shown))
    expect(ids(p.list(true))).toEqual([...ids(p.shown), ...ids(p.hidden)])
    const reasons = Object.fromEntries(p.hidden.map((x) => [x.id, reachabilityReason(p.view(x))]))
    expect(reasons["claude-denied"]).toEqual({ key: "dialog.model.reachability.reason.denied" })
    expect(reasons["claude-unavailable"]).toEqual({ key: "dialog.model.reachability.reason.unavailable" })
    expect(reasons["claude-invalid"]).toEqual({ key: "dialog.model.reachability.reason.invalid" })
    expect(reasons["claude-error"]).toEqual({ text: "socket hang up" })
    expect(reasons["claude-unchecked"]).toEqual({ key: "dialog.model.reachability.reason.unchecked" })
    expect(reasons["claude-norow"]).toEqual({ key: "dialog.model.reachability.reason.unchecked" })
    for (const x of p.hidden) expect(p.view(x).greyed).toBe(true)
  })

  test("error without a reason falls back to 'Probe failed'", () => {
    const snap = parseReachabilityResponse(response([row("a", "m", "error")], [prov("a", true)]))
    const p = partitionByReachability([item("a", "m")], keyOf, snap)
    expect(reachabilityReason(p.view(p.hidden[0]))).toEqual({ key: "dialog.model.reachability.reason.error" })
  })

  test("rate-limited is shown with a warning; ok has none", () => {
    const p = partitionByReachability(items, keyOf, mixed)
    expect(p.view(item("bedrock", "claude-ratelimited")).tag).toBe("rate-limited")
    expect(p.view(item("bedrock", "claude-ratelimited")).greyed).toBe(false)
    expect(p.view(item("bedrock", "claude-ok")).tag).toBeUndefined()
  })

  test("unchecked models of a never-probed provider show, labelled unchecked", () => {
    const snap = parseReachabilityResponse(
      response(
        [row("bedrock", "claude-ok", "ok"), row("openai", "gpt-a", "unchecked")],
        [prov("bedrock", true), prov("openai", false)],
      ),
    )
    const list = [item("bedrock", "claude-ok"), item("openai", "gpt-a"), item("openai", "gpt-b")]
    const p = partitionByReachability(list, keyOf, snap)
    expect(ids(p.shown)).toEqual(["bedrock:claude-ok", "openai:gpt-a", "openai:gpt-b"])
    expect(p.hiddenCount).toBe(0)
    expect(p.view(item("openai", "gpt-a")).tag).toBe("unchecked")
    expect(p.view(item("openai", "gpt-b")).tag).toBe("unchecked")
    expect(p.view(item("openai", "gpt-a")).status).toBe("unchecked")
  })

  test("the currently selected model is retained even if dead, and marked", () => {
    const p = partitionByReachability(items, keyOf, mixed, { providerID: "bedrock", modelID: "claude-denied" })
    expect(ids(p.shown)).toEqual(["bedrock:claude-ok", "bedrock:claude-denied", "bedrock:claude-ratelimited"])
    expect(p.hiddenCount).toBe(5)
    const v = p.view(item("bedrock", "claude-denied"))
    expect(v.tag).toBe("selected-dead")
    expect(v.greyed).toBe(false)
    expect(reachabilityReason(v)).toEqual({ key: "dialog.model.reachability.reason.denied" })
  })

  test("route unavailable → passthrough: everything shows exactly as today", () => {
    const p = partitionByReachability(items, keyOf, undefined, { providerID: "bedrock", modelID: "claude-denied" })
    expect(ids(p.shown)).toEqual(ids(items))
    expect(p.hiddenCount).toBe(0)
    expect(ids(p.list(true))).toEqual(ids(items))
    for (const x of items) {
      const v = p.view(x)
      expect(v.tag).toBeUndefined()
      expect(v.greyed).toBe(false)
      expect(reachabilityReason(v)).toBeUndefined()
    }
  })
})
