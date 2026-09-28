/**
 * remote-create-preflight.test.ts — #1643 (completes #1484 AC3)
 *
 * The composer's pre-flight orchestration: given the picked machine, query the
 * creation-target gate (and, for a remote target, the peer-home-base gate),
 * then decide the create plan — proceed local, proceed remote (armed + remote
 * directory), or refuse with an inline reason. Pure over injected fetchers so
 * it is unit-testable without a live server.
 */
import { describe, expect, test } from "bun:test"
import { runCreatePreflight, type PreflightFetchers } from "./remote-create-preflight"
import { OWNER_HEADER } from "./remote-create-header"

function fetchers(over?: Partial<PreflightFetchers>): PreflightFetchers {
  return {
    getCreationTarget: async (machine) => {
      if (machine === "studio") return { ok: true, target: { kind: "remote", machineId: "studio" } }
      if (machine === "local") return { ok: true, target: { kind: "local" } }
      if (machine === "blocked") return { ok: true, target: { kind: "blocked", machineId: "blocked", reason: "no-control-grant" } }
      return { ok: true, target: { kind: "local" } }
    },
    getPeerHomeBase: async (machine) => {
      if (machine === "studio") return { ok: true, directory: "/Users/studio/work" }
      return { ok: false, reason: "no-remote-root" }
    },
    ...over,
  }
}

describe("#1643 runCreatePreflight", () => {
  test("no machine selected → local, proceed, no arm, no remote directory", async () => {
    const r = await runCreatePreflight(undefined, fetchers())
    expect(r.proceed).toBe(true)
    expect(r.ownerToArm).toBeUndefined()
    expect(r.remoteDirectory).toBeUndefined()
  })

  test("local machine → local, proceed, no arm", async () => {
    const r = await runCreatePreflight("local", fetchers())
    expect(r.proceed).toBe(true)
    expect(r.ownerToArm).toBeUndefined()
  })

  test("remote machine with directory → proceed, arm owner, carry remote dir", async () => {
    const r = await runCreatePreflight("studio", fetchers())
    expect(r.proceed).toBe(true)
    expect(r.ownerToArm).toBe("studio")
    expect(r.remoteDirectory).toBe("/Users/studio/work")
  })

  test("blocked target → refuse with reason, no arm", async () => {
    const r = await runCreatePreflight("blocked", fetchers())
    expect(r.proceed).toBe(false)
    expect(r.blockedReason).toBe("no-control-grant")
    expect(r.ownerToArm).toBeUndefined()
  })

  test("remote but home-base unresolvable → refuse no-remote-root, no arm", async () => {
    const r = await runCreatePreflight("studio", fetchers({
      getPeerHomeBase: async () => ({ ok: false, reason: "no-remote-root" }),
    }))
    expect(r.proceed).toBe(false)
    expect(r.blockedReason).toBe("no-remote-root")
    expect(r.ownerToArm).toBeUndefined()
  })

  test("a gate fetch that throws → refuse safely (never a silent local remote)", async () => {
    const r = await runCreatePreflight("studio", fetchers({
      getCreationTarget: async () => {
        throw new Error("network")
      },
    }))
    expect(r.proceed).toBe(false)
    expect(r.ownerToArm).toBeUndefined()
    expect(r.blockedReason).toBe("transport-down")
  })

  test("the owner to arm equals what the header producer would emit", async () => {
    const r = await runCreatePreflight("studio", fetchers())
    // planRemoteCreate would put ownerToArm under OWNER_HEADER
    expect(r.ownerToArm).toBe("studio")
    expect(OWNER_HEADER).toBe("x-amicode-owner")
  })
})
