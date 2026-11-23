import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveWithCatalogRecovery, singleFlight } from "./catalog-recovery"

// The bootstrap loads the agent list once; a failed load (engine mid re-init)
// left it empty for the window's lifetime and every send was refused with
// "Select an agent and model" even though a model was picked. The guard now
// reloads the catalog once before refusing, names what is missing, and never
// invents an agent.

const MODEL = { id: "anthropic.claude-opus-5-5" }
const PLAN = { name: "plan" }

describe("resolveWithCatalogRecovery", () => {
  test("a resolved selection sends without reloading", async () => {
    let reloads = 0
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: MODEL, agent: PLAN }),
      reload: async () => void reloads++,
    })
    expect(result).toEqual({ model: MODEL, agent: PLAN, missing: "none", reloaded: false })
    expect(reloads).toBe(0)
  })

  test("an empty agent list is reloaded once and the send goes through", async () => {
    let agents: { name: string }[] = []
    let reloads = 0
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: MODEL, agent: agents[0] }),
      reload: async () => {
        reloads++
        agents = [PLAN]
      },
    })
    expect(result.missing).toBe("none")
    expect(result.agent).toBe(PLAN)
    expect(result.reloaded).toBe(true)
    expect(reloads).toBe(1)
  })

  test("a disconnected provider recovers when the providers reload", async () => {
    let connected = false
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: connected ? MODEL : undefined, agent: PLAN }),
      reload: async () => void (connected = true),
    })
    expect(result.missing).toBe("none")
    expect(result.model).toBe(MODEL)
  })

  test("agents still missing after the reload refuses as 'agent' — never a defaulted agent", async () => {
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: MODEL, agent: undefined as { name: string } | undefined }),
      reload: async () => {},
    })
    expect(result.missing).toBe("agent")
    expect(result.agent).toBeUndefined()
  })

  test("agents present but model unusable refuses as 'model'", async () => {
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: undefined, agent: PLAN }),
      reload: async () => {},
    })
    expect(result.missing).toBe("model")
  })

  test("both missing reports 'agent' (the catalog itself didn't load)", async () => {
    const result = await resolveWithCatalogRecovery({ read: () => ({ model: undefined, agent: undefined }), reload: async () => {} })
    expect(result.missing).toBe("agent")
  })

  test("a reload that throws is swallowed and the guard still answers", async () => {
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: MODEL, agent: undefined }),
      reload: async () => {
        throw new Error("engine down")
      },
    })
    expect(result.missing).toBe("agent")
    expect(result.reloaded).toBe(true)
  })

  test("a reload that hangs is bounded by the timeout", async () => {
    const start = Date.now()
    const result = await resolveWithCatalogRecovery({
      read: () => ({ model: MODEL, agent: undefined }),
      reload: () => new Promise(() => {}),
      timeoutMs: 30,
    })
    expect(result.missing).toBe("agent")
    expect(Date.now() - start).toBeLessThan(1_000)
  })
})

describe("singleFlight", () => {
  test("concurrent calls for one key share one run; a later call runs again", async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const reload = singleFlight(async (_dir: string) => {
      runs++
      await gate
    })
    const a = reload("/repo")
    const b = reload("/repo")
    expect(a).toBe(b)
    release()
    await a
    await reload("/repo")
    expect(runs).toBe(2)
  })

  test("different keys run independently, and a rejection clears the slot", async () => {
    let runs = 0
    const reload = singleFlight(async (dir: string) => {
      runs++
      if (dir === "/bad") throw new Error("nope")
    })
    await reload("/a")
    await expect(reload("/bad")).rejects.toThrow("nope")
    await expect(reload("/bad")).rejects.toThrow("nope")
    expect(runs).toBe(3)
  })
})

// Wiring pin (createPromptSubmit needs the whole provider tree, so it is pinned
// by source, like submit-stream-gap.test.ts).
describe("submit guard wiring", () => {
  const submit = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")
  const serverSync = readFileSync(join(import.meta.dir, "..", "..", "context", "server-sync.tsx"), "utf8")

  test("the guard recovers through the server-sync catalog reload before refusing", () => {
    expect(submit).toContain("await resolveWithCatalogRecovery({")
    expect(submit).toContain("reload: () => serverSync().reloadCatalog(sdk().directory)")
    expect(submit.indexOf("resolveWithCatalogRecovery({")).toBeLessThan(submit.indexOf("input.addToHistory"))
  })

  test("the refusal names what is missing; the old catch-all toast is gone", () => {
    expect(submit).toContain("prompt.toast.agentsUnavailable.title")
    expect(submit).toContain("prompt.toast.modelUnavailable.title")
    expect(submit).not.toContain("prompt.toast.modelAgentRequired")
  })

  test("the agent is never defaulted in the guard", () => {
    expect(submit).not.toMatch(/currentAgent\?\.name \?\? "build"/)
    expect(submit).toContain("agent: local.agent.current()")
  })

  test("server-sync reloads agents fresh (not the cached failure) and the providers", () => {
    expect(serverSync).toContain("const reloadCatalog = singleFlight(")
    expect(serverSync).toContain("fetchQuery({ ...queryOptionsApi.agents(key), staleTime: 0 })")
    expect(serverSync).toContain('setStore("agent", agents)')
    expect(serverSync).toContain("refreshProviders()")
    expect(serverSync).toMatch(/refreshProviders,\s*reloadCatalog,/)
  })
})
