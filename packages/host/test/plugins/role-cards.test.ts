// Role-card parity (#2062): the read-only cards (analyzer, hypothesizer) must stay unable to run a shell command or
// edit a file under v2's renamed permission keys. Layers: the key-translation helper; the real cards through it; the
// real engine's card loader (a real host process); and a real agent turn that tries both.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ACTIONS, cardPermissions, migratePermission, renderV2Card, RoleCardError, type Rule } from "../../src/plugins/role-cards.ts"
import { match } from "../../src/plugins/wildcard.ts"
import { cleanup, makeSandbox, waitFor, type Sandbox } from "../helpers.ts"
import { fakeProvider, type Reply } from "./fake-provider.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

const agentsDir = path.resolve(import.meta.dir, "../../../extension/agents")
const card = (name: string) => fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf8")
const cards = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))

/** The engine's own rule evaluation: last matching rule wins; no match asks. */
const evaluate = (action: string, resource: string, rules: readonly Rule[]) =>
  [...rules].reverse().find((rule) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? "ask"

describe("migratePermission: v1 keys to v2 names", () => {
  test.each([
    ["bash", "shell"],
    ["write", "edit"],
    ["patch", "edit"],
    ["apply_patch", "edit"],
    ["task", "subagent"],
    ["edit", "edit"],
    ["read", "read"],
    ["external_directory", "external_directory"],
  ])("`%s: deny` becomes a deny on the v2 action `%s`", (v1, v2) => {
    expect(migratePermission({ [v1]: "deny" })).toEqual([{ action: v2, resource: "*", effect: "deny" }])
  })
  test("every renamed key is covered by ACTIONS (the table the engine's own v1 migration also uses)", () => {
    expect(ACTIONS).toMatchObject({ bash: "shell", write: "edit", patch: "edit", apply_patch: "edit", task: "subagent" })
  })
  test("pattern mappings keep their order (the last match wins, so order is policy)", () => {
    expect(migratePermission({ bash: { "*": "deny", "git status": "allow" } })).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
  })
  test("a bare effect applies to everything", () => {
    expect(migratePermission("deny")).toEqual([{ action: "*", resource: "*", effect: "deny" }])
  })
  test("an unknown key fails loudly instead of being dropped, naming the key and the card", () => {
    expect(() => migratePermission({ bsah: "deny" }, "analyzer.md")).toThrow(/analyzer\.md.*unknown permission key "bsah"/)
  })
  test("an invalid effect fails loudly", () => {
    expect(() => migratePermission({ bash: "denyy" })).toThrow(RoleCardError)
    expect(() => migratePermission({ bash: { "*": "nope" } })).toThrow(RoleCardError)
  })
  test("no permission block means no rules (the card inherits the agent default, which the host policy then constrains)", () => {
    expect(migratePermission(undefined)).toEqual([])
  })
})

describe("the shipped role cards", () => {
  test("there are cards to check", () => {
    expect(cards).toEqual(expect.arrayContaining(["analyzer", "hypothesizer", "experimenter", "implementer", "librarian", "research", "develop"]))
  })
  test.each(cards)("%s translates without an unknown key", (name) => {
    expect(() => cardPermissions(card(name), `${name}.md`)).not.toThrow()
  })
  test.each(["analyzer", "hypothesizer"])("%s denies a shell command and an edit under every v2 name", (name) => {
    const rules = cardPermissions(card(name), `${name}.md`)
    for (const action of ["shell", "edit"]) expect(evaluate(action, "anything at all", rules)).toBe("deny")
  })
  test.each(["experimenter", "implementer", "librarian", "research", "develop"])("%s keeps its explicit shell and edit grants", (name) => {
    const rules = cardPermissions(card(name), `${name}.md`)
    expect(evaluate("shell", "ls", rules)).toBe("allow")
    expect(evaluate("edit", "/x", rules)).toBe("allow")
  })
  test.each(["analyzer", "hypothesizer"])("renderV2Card(%s) is native: renamed permissions, sampling moved to request.body, deny preserved", (name) => {
    const text = renderV2Card(card(name), `${name}.md`)
    expect(text).toContain("permissions:")
    expect(text).not.toMatch(/^permission:/m)
    expect(text).toMatch(/temperature/)
    const front = /^---\n([\s\S]*?)\n---/.exec(text)![1]!
    const parsed = Bun.YAML.parse(front) as { permissions: Rule[]; request: { body: { temperature: number } } }
    expect(evaluate("shell", "x", parsed.permissions)).toBe("deny")
    expect(evaluate("edit", "/x", parsed.permissions)).toBe("deny")
    expect(typeof parsed.request.body.temperature).toBe("number")
  })
})

// ── the real engine's card loader ───────────────────────────────────────────────────────────────────────────────
async function hostWithCards(sb: Sandbox, files: Record<string, string>, pluginConfig: Record<string, unknown> = {}, content = "{}") {
  const dir = path.join(sb.serverConfig, "agents")
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.md`), text)
  return startPluginHost(sb, { context: { extensionDir: null }, ...pluginConfig }, {}, {
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: { directory: sb.serverConfig, project: false, claude: false, content },
  })
}
const agentRules = async (host: { url: string; auth: Record<string, string> }, sb: Sandbox, id: string) => {
  const body = await json(await fetch(host.url + "/api/agent", { headers: { ...host.auth, ...dirHeader(sb) } }))
  return (body.data as Array<{ id: string; permissions: Rule[] }>).find((a) => a.id === id)?.permissions
}

describe("the engine's loader applies the cards' denies (observed, real host process)", () => {
  test.each(["analyzer", "hypothesizer"])("%s: the loaded agent's rules deny `shell` and `edit` for any resource", async (name) => {
    const sb = makeSandbox(`card-${name}`)
    const host = await hostWithCards(sb, { [name]: card(name) })
    const rules = await agentRules(host, sb, name)
    expect(rules).toBeDefined()
    for (const [v1, v2] of [["bash", "shell"], ["edit", "edit"], ["write", "edit"], ["patch", "edit"]] as const) {
      expect([v1, evaluate(v2, "/etc/passwd", rules!)]).toEqual([v1, "deny"])
    }
  }, 60_000)

  test("HAZARD, observed: a v1 `permission:` block in a card that also has a v2-native key is IGNORED — the deny vanishes; the migrated card keeps it", async () => {
    const sb = makeSandbox("card-hazard")
    const mixed = card("analyzer").replace("mode: subagent\n", "mode: subagent\ndisabled: false\n")
    expect(mixed).toContain("disabled: false")
    const host = await hostWithCards(sb, { mixed, migrated: renderV2Card(mixed, "mixed.md") })
    const lost = await agentRules(host, sb, "mixed")
    expect(evaluate("shell", "rm -rf /", lost!)).toBe("allow") // the engine only logged "ignored unsupported agent fields"
    const kept = await agentRules(host, sb, "migrated")
    expect(evaluate("shell", "rm -rf /", kept!)).toBe("deny")
    expect(evaluate("edit", "/x", kept!)).toBe("deny")
  }, 60_000)
})

// ── a real agent turn ────────────────────────────────────────────────────────────────────────────────────────────
describe("a real turn: the analyzer cannot run a shell command or edit a file; the experimenter control can", () => {
  async function runCard(name: string, tool: "shell" | "write") {
    const sb = makeSandbox(`turn-${name}-${tool}`)
    const target = path.join(sb.work, `${tool}-marker.txt`)
    const call: Reply = tool === "shell" ? { tool: { name: "shell", arguments: { command: `touch ${target}` } } } : { tool: { name: "write", arguments: { path: target, content: "written" } } }
    const provider = await fakeProvider((_r, n) => (n === 0 ? call : { text: "done" }))
    // grant everything in the host policy, so ONLY the card's own rules stand between the agent and the action
    const host = await hostWithCards(
      sb,
      { [name]: card(name) },
      { permission: { replaceDefaults: true, grants: [{ action: "*", resource: "*", effect: "allow" }] } },
      JSON.stringify(provider.providerConfig(["m"])),
    )
    const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
    const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "c", agent: name, location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) }))
    await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) })
    await waitFor(() => provider.requests.length >= 2, { what: "the model's follow-up after the tool result", timeoutMs: 45_000 })
    provider.stop()
    const toolResult = JSON.stringify(provider.requests[1]!.body.messages.filter((m: any) => m.role === "tool"))
    const offered = (provider.requests[0]!.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    return { ran: fs.existsSync(target), toolResult, offered }
  }

  test("analyzer: shell is refused and nothing runs", async () => {
    const result = await runCard("analyzer", "shell")
    expect(result.ran).toBe(false)
    // v2 goes further than refusing the call: a tool the agent is denied is not even offered to the model
    expect(result.offered).not.toContain("shell")
    expect(result.toolResult).toMatch(/No tool named .{1,6}shell|denied|blocked|not allowed/i)
  }, 90_000)
  test("analyzer: write is refused and nothing is written", async () => {
    const result = await runCard("analyzer", "write")
    expect(result.ran).toBe(false)
    expect(result.offered).not.toContain("write")
    expect(result.offered).not.toContain("edit")
    expect(result.toolResult).toMatch(/No tool named .{1,6}write|denied|blocked|not allowed/i)
  }, 90_000)
  test("control — experimenter (bash: allow, edit: allow) does run the shell command", async () => {
    const result = await runCard("experimenter", "shell")
    expect(result.offered).toContain("shell")
    expect(result.ran).toBe(true)
  }, 90_000)
  test("control — experimenter does write the file", async () => {
    const result = await runCard("experimenter", "write")
    expect(result.offered).toEqual(expect.arrayContaining(["write", "edit"]))
    expect(result.ran).toBe(true)
  }, 90_000)
})
