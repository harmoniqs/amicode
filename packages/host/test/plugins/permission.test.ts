// Default-deny permission policy (#2062). v2 agents default to allow-all, so the host ships its own policy on the
// `permission.evaluate` hook: with no explicit grant a request is denied; a grant can only keep or tighten what the
// engine already decided (a configured deny never reaches the hook, an `ask` is never loosened to `allow`).
import { describe, expect, test } from "bun:test"
import { decide, defaultPolicy, permissionPlugin, type Grant } from "../../src/plugins/permission.ts"
import { load } from "./runtime.ts"

const policy = (grants: Grant[]) => ({ grants })

describe("decide: default-deny", () => {
  test("no grants at all: a shell command is denied", () => {
    expect(decide(policy([]), { action: "shell", resources: ["rm -rf /"], effect: "allow" }).effect).toBe("deny")
  })
  test("no grants at all: an edit is denied", () => {
    expect(decide(policy([]), { action: "edit", resources: ["/work/a.ts"], effect: "allow" }).effect).toBe("deny")
  })
  test("an unknown action (e.g. a freshly-installed MCP tool) is denied until granted", () => {
    expect(decide(defaultPolicy({ home: "/h" }), { action: "mcp__evil__exfiltrate", resources: ["*"], effect: "allow" }).effect).toBe("deny")
  })
  test("the denial names the missing grant, so an operator can fix it", () => {
    const result = decide(policy([]), { action: "shell", resources: ["ls"], effect: "allow" })
    expect(result.message).toContain("shell")
    expect(result.message).toContain("ls")
  })
})

describe("decide: grants", () => {
  const edit: Grant = { action: "edit", resource: "/work/**", effect: "allow" }
  test("an edit inside the allowlist keeps the engine's allow", () => {
    expect(decide(policy([edit]), { action: "edit", resources: ["/work/src/a.ts"], effect: "allow" }).effect).toBe("allow")
  })
  test("an edit outside the allowlist is denied", () => {
    expect(decide(policy([edit]), { action: "edit", resources: ["/etc/passwd"], effect: "allow" }).effect).toBe("deny")
  })
  test("one resource outside the allowlist denies the whole request", () => {
    expect(decide(policy([edit]), { action: "edit", resources: ["/work/a", "/etc/passwd"], effect: "allow" }).effect).toBe("deny")
  })
  test("a grant never loosens an engine ask", () => {
    expect(decide(policy([edit]), { action: "edit", resources: ["/work/.env"], effect: "ask" }).effect).toBe("ask")
  })
  test("an `ask` grant tightens an engine allow", () => {
    const grants = policy([{ action: "shell", resource: "*", effect: "ask" }])
    expect(decide(grants, { action: "shell", resources: ["git push"], effect: "allow" }).effect).toBe("ask")
  })
  test("later grants win (last match), so a narrow deny can follow a broad allow", () => {
    const grants = policy([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "rm *", effect: "deny" },
    ])
    expect(decide(grants, { action: "shell", resources: ["ls"], effect: "allow" }).effect).toBe("allow")
    expect(decide(grants, { action: "shell", resources: ["rm -rf x"], effect: "allow" }).effect).toBe("deny")
  })
  test("an engine deny stays a deny whatever the grants say", () => {
    expect(decide(policy([{ action: "*", resource: "*", effect: "allow" }]), { action: "shell", resources: ["x"], effect: "deny" }).effect).toBe("deny")
  })
})

describe("defaultPolicy", () => {
  const p = defaultPolicy({ home: "/home/u", scratch: "/tmp/amicode-work" })
  test("reading, searching and asking the user are allowed out of the box", () => {
    for (const action of ["read", "glob", "grep", "question"]) expect(decide(p, { action, resources: ["x"], effect: "allow" }).effect).toBe("allow")
  })
  test("shell is NOT granted by default", () => {
    expect(decide(p, { action: "shell", resources: ["ls"], effect: "allow" }).effect).toBe("deny")
  })
  test("edit is granted only in the scratch directory", () => {
    expect(decide(p, { action: "edit", resources: ["/tmp/amicode-work/solve.jl"], effect: "allow" }).effect).toBe("allow")
    expect(decide(p, { action: "edit", resources: ["/home/u/.ssh/authorized_keys"], effect: "allow" }).effect).toBe("deny")
  })
  test("external_directory is granted for the v1 roots only (scratch, ~/.amico)", () => {
    expect(decide(p, { action: "external_directory", resources: ["/home/u/.amico/runs/x/result.toml"], effect: "allow" }).effect).toBe("allow")
    expect(decide(p, { action: "external_directory", resources: ["/home/u/.ssh/id_rsa"], effect: "allow" }).effect).toBe("deny")
  })
  test("network tools need approval", () => {
    expect(decide(p, { action: "webfetch", resources: ["https://x"], effect: "allow" }).effect).toBe("ask")
  })
})

describe("permissionPlugin: the evaluate hook", () => {
  test("registers on permission.evaluate and mutates the event in place", async () => {
    const harness = await load(permissionPlugin(policy([])))
    expect(harness.registered("permission")).toEqual(["evaluate"])
    const event = await harness.trigger("permission", "evaluate", { sessionID: "s", action: "shell", resources: ["id"], effect: "allow" as string, message: undefined as string | undefined })
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("shell")
  })
  test("a granted request is left exactly as the engine decided it", async () => {
    const harness = await load(permissionPlugin(policy([{ action: "read", resource: "*", effect: "allow" }])))
    const event = await harness.trigger("permission", "evaluate", { sessionID: "s", action: "read", resources: ["/a"], effect: "allow" as string, message: undefined as string | undefined })
    expect(event).toEqual({ sessionID: "s", action: "read", resources: ["/a"], effect: "allow", message: undefined })
  })
})
