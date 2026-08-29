import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pickVaultServer, vaultMountsState } from "./vault-browser-model"

// amicode#105: the drawer is the vault's ONLY host, so it must work on every
// route — and say why when it can't. Pre-fix, a failed mounts fetch and an
// empty vault both rendered the same bare "empty" line (nothing fails
// silently), and the fetch keyed only on the focused server.
describe("pickVaultServer", () => {
  const a = { name: "a" } as never
  const b = { name: "b" } as never

  test("prefers the focused server when set", () => {
    expect(pickVaultServer({ current: a, list: [a, b], healthy: () => false })).toBe(a)
  })

  test("falls back to the first healthy server when none is focused", () => {
    expect(pickVaultServer({ current: undefined, list: [a, b], healthy: (s) => s === b })).toBe(b)
  })

  test("falls back to the first server when none is healthy", () => {
    expect(pickVaultServer({ current: undefined, list: [a, b], healthy: () => false })).toBe(a)
  })

  test("undefined when there are no servers at all", () => {
    expect(pickVaultServer({ current: undefined, list: [], healthy: () => false })).toBeUndefined()
  })
})

describe("vaultMountsState", () => {
  test("loading while the fetch is in flight", () => {
    expect(vaultMountsState({ raw: undefined, loading: true, noServer: false }).kind).toBe("loading")
  })

  test("error when the fetch failed (a named state, never the empty copy)", () => {
    expect(vaultMountsState({ raw: undefined, loading: false, noServer: false }).kind).toBe("error")
  })

  test("no-server when there is no server to ask", () => {
    expect(vaultMountsState({ raw: undefined, loading: false, noServer: true }).kind).toBe("no-server")
  })

  test("empty when the vault serves zero mounts", () => {
    expect(vaultMountsState({ raw: { mounts: [] }, loading: false, noServer: false }).kind).toBe("empty")
  })

  test("ready with mounts", () => {
    const state = vaultMountsState({ raw: { mounts: [{ id: "m1" }] }, loading: false, noServer: false })
    expect(state.kind).toBe("ready")
    if (state.kind === "ready") expect(state.mounts).toHaveLength(1)
  })
})

// The drawer renders on EVERY route — the pre-fix `!params.id` guard stood it
// down inside sessions and made the titlebar button look dead there.
describe("the vault drawer is global (amicode#105)", () => {
  test("vault-panel.tsx carries no route-param guard", () => {
    const source = readFileSync(join(import.meta.dir, "vault-panel.tsx"), "utf8")
    expect(source).not.toContain("params.id")
  })
})
