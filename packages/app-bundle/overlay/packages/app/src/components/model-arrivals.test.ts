// amicode#2000: the picker's "New" tag — 7 days from first_seen_at, available
// arrivals only, regional variants as one model. Pure.
import { describe, expect, test } from "bun:test"
import {
  baseModelId,
  isNewModel,
  NEW_TAG_MS,
  newModelKeys,
  parseArrivalsResponse,
  type ModelArrival,
} from "./model-arrivals"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const arrival = (over: Partial<ModelArrival>): ModelArrival => ({
  id: "moonshotai/kimi-k3.1-pro",
  provider: "moonshotai",
  model: "kimi-k3.1-pro",
  status: "ok",
  kind: "available",
  first_seen_at: NOW - DAY,
  seen: false,
  watch: false,
  ...over,
})
const ref = (providerID: string, modelID: string) => ({ providerID, modelID })

describe("New tag", () => {
  test("shown for 7 days after first_seen_at, then not", () => {
    const a = arrival({ first_seen_at: NOW - 6 * DAY })
    expect(isNewModel(newModelKeys([a], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(true)
    expect(isNewModel(newModelKeys([a], NOW + 2 * DAY), ref("moonshotai", "kimi-k3.1-pro"))).toBe(false)
    const edge = arrival({ first_seen_at: NOW - NEW_TAG_MS })
    expect(isNewModel(newModelKeys([edge], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(false)
    const justUnder = arrival({ first_seen_at: NOW - NEW_TAG_MS + 1 })
    expect(isNewModel(newModelKeys([justUnder], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(true)
  })

  test("read (seen) arrivals still wear the tag until the 7 days are up", () => {
    expect(isNewModel(newModelKeys([arrival({ seen: true })], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(true)
  })

  test("only available arrivals are tagged", () => {
    for (const kind of ["listed", "needs-allowlist", "needs-agreement"] as const)
      expect(isNewModel(newModelKeys([arrival({ kind })], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(false)
  })

  test("other models and other providers are not tagged; a future first_seen_at is ignored", () => {
    const keys = newModelKeys([arrival({})], NOW)
    expect(isNewModel(keys, ref("moonshotai", "kimi-k3"))).toBe(false)
    expect(isNewModel(keys, ref("openrouter", "kimi-k3.1-pro"))).toBe(false)
    expect(isNewModel(newModelKeys([arrival({ first_seen_at: NOW + DAY })], NOW), ref("moonshotai", "kimi-k3.1-pro"))).toBe(false)
  })

  test("every regional variant of the announced base id is tagged", () => {
    const a = arrival({ provider: "amazon-bedrock", model: "global.google.gemini-4-carbon", id: "amazon-bedrock/google.gemini-4-carbon" })
    const keys = newModelKeys([a], NOW)
    for (const id of ["us.google.gemini-4-carbon", "global.google.gemini-4-carbon", "eu.google.gemini-4-carbon", "google.gemini-4-carbon"])
      expect(isNewModel(keys, ref("amazon-bedrock", id))).toBe(true)
    expect(isNewModel(keys, ref("amazon-bedrock", "us.google.gemini-3"))).toBe(false)
  })

  test("no arrivals → no tags", () => {
    expect(newModelKeys(undefined, NOW).size).toBe(0)
    expect(baseModelId("users.model")).toBe("users.model")
  })
})

describe("parseArrivalsResponse", () => {
  test("parses the service body and drops malformed rows; ok:false → undefined", () => {
    const body = {
      ok: true,
      arrivals: [
        { id: "a/b", provider: "a", model: "b", status: "ok", kind: "available", first_seen_at: 5, seen: true, watch: true },
        { id: "x", provider: "a", model: "b", status: "ok", kind: "weird", first_seen_at: 5 },
        { id: "y", provider: "a", model: "b", kind: "listed" },
        7,
      ],
    }
    expect(parseArrivalsResponse(body)).toEqual([
      { id: "a/b", provider: "a", model: "b", status: "ok", kind: "available", first_seen_at: 5, seen: true, watch: true },
    ])
    expect(parseArrivalsResponse({ ok: false, error: "x" })).toBeUndefined()
    expect(parseArrivalsResponse(null)).toBeUndefined()
  })
})
