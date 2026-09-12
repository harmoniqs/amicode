import { describe, expect, test } from "bun:test"
import { loadSolverMode, saveSolverMode } from "./solver-toggle"

const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe("solver mode persistence", () => {
  test("defaults to piccolo; hp round-trips; garbage → piccolo", () => {
    const s = mem()
    expect(loadSolverMode(s)).toBe("piccolo")
    saveSolverMode("hp", s)
    expect(loadSolverMode(s)).toBe("hp")
    s.setItem("amicode-solver-mode", "nonsense")
    expect(loadSolverMode(s)).toBe("piccolo")
  })
  test("storage failures fail soft", () => {
    const broken = {
      getItem: () => {
        throw new Error("nope")
      },
      setItem: () => {
        throw new Error("nope")
      },
    }
    expect(loadSolverMode(broken)).toBe("piccolo")
    expect(() => saveSolverMode("hp", broken)).not.toThrow()
  })
})

// ── amicode#200: the solver toggle owns the Company Compute connection ──────
import { solverConnectionDot, hpClickAction, hpAfterConnect, modeAfterDisconnect } from "./solver-toggle"
import type { ConnectionView } from "./connections"

const view = (state: ConnectionView["state"]): ConnectionView => ({
  id: "company-compute",
  state,
  rawState: state,
  validatedAt: "—",
  stale: false,
})

describe("solver connection dot (#200 AC1)", () => {
  test("connected → connected; needs-key/absent → none; trouble states → attention", () => {
    expect(solverConnectionDot(view("connected"))).toBe("connected")
    expect(solverConnectionDot(undefined)).toBe("none")
    expect(solverConnectionDot(view("needs-key"))).toBe("none")
    for (const s of ["expired", "invalid", "unreachable", "unentitled", "validating", "unknown"] as const) {
      expect(solverConnectionDot(view(s))).toBe("attention")
    }
  })
})

describe("HP segment click routing (#200 AC2/AC3)", () => {
  test("unconnected always routes to connect; connected activates", () => {
    expect(hpClickAction("none")).toBe("connect")
    expect(hpClickAction("attention")).toBe("connect")
    expect(hpClickAction("connected")).toBe("activate")
  })
})

describe("connect flips HP only on a landed connection (#200 AC2/AC7)", () => {
  test("ok+connected flips; failures and non-connected results do not", () => {
    expect(hpAfterConnect({ ok: true, connection: view("connected") })).toBe(true)
    expect(hpAfterConnect({ ok: false, connection: view("connected") })).toBe(false)
    expect(hpAfterConnect({ ok: true, connection: view("validating") })).toBe(false)
    expect(hpAfterConnect({ ok: true })).toBe(false)
  })
  test("disconnect never leaves HP selected", () => {
    expect(modeAfterDisconnect()).toBe("piccolo")
  })
})

// ── opencode#78: the toggle's picks reach the server ────────────────────────
import { releaseRequestForPick } from "./solver-toggle"

describe("which picks travel to the server (opencode#78)", () => {
  test("piccolo releases the tier; hp NEVER requests a flip from the client", () => {
    // selecting piccolo is the only durable write the toggle may ask for
    expect(releaseRequestForPick("piccolo")).toBe("piccolo")
    // hp follows a validated Company Compute credential — a client-side hp
    // writer would be the duplicate flip ADR 0001 forbids
    expect(releaseRequestForPick("hp")).toBeUndefined()
  })

  test("the disconnect invariant routes through the same release", () => {
    expect(releaseRequestForPick(modeAfterDisconnect())).toBe("piccolo")
  })
})
