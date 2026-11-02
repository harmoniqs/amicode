// Default-deny, end to end (#2062): a real host process, the default plugin set, a loopback model asking an agent
// to run a shell command and to write files. With no explicit grant nothing runs; a scoped grant opens exactly its scope.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanup, makeSandbox, waitFor } from "../helpers.ts"
import { fakeProvider, type Reply } from "./fake-provider.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

async function attempt(calls: Reply[], permission: Record<string, unknown> | undefined, arrange?: (work: string) => void) {
  const sb = makeSandbox("perm-e2e")
  arrange?.(sb.work)
  const provider = await fakeProvider((_r, n) => calls[n] ?? { text: "done" })
  const host = await startPluginHost(
    sb,
    { context: { extensionDir: null }, ...(permission ? { permission } : {}) },
    {},
    { models: { fetch: false }, fs: { filewatcher: false, fff: false }, config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(provider.providerConfig(["m"])) } },
  )
  const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
  const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "p", location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) }))
  await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) })
  await waitFor(() => provider.requests.length >= calls.length + 1, { what: "the turn to finish its tool calls", timeoutMs: 45_000 })
  provider.stop()
  const results = provider.requests.at(-1)!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))
  return { sb, results }
}

describe("with the default plugin set and no explicit grant", () => {
  test("a shell command is refused, with a reason that names the missing grant, and does not run", async () => {
    const marker = (work: string) => path.join(work, "shell-marker")
    let sb!: Awaited<ReturnType<typeof attempt>>["sb"]
    const result = await attempt([{ tool: { name: "shell", arguments: { command: "touch shell-marker" } } }], undefined)
    sb = result.sb
    expect(fs.existsSync(marker(sb.work))).toBe(false)
    expect(result.results.join("\n")).toContain("default-deny: no grant for shell")
  }, 90_000)

  test("a file edit is refused when it is outside every granted path", async () => {
    const result = await attempt([{ tool: { name: "write", arguments: { path: "/tmp/never-written-by-h1b.txt", content: "x" } } }], undefined)
    expect(fs.existsSync("/tmp/never-written-by-h1b.txt")).toBe(false)
    expect(result.results.join("\n")).toMatch(/default-deny: no grant for (edit|external_directory)/)
  }, 90_000)
})

describe("a scoped grant opens exactly its scope", () => {
  test("edit allowed under the granted directory, refused beside it; shell stays refused", async () => {
    const sb = makeSandbox("perm-scope")
    const allowed = path.join(sb.work, "allowed")
    const inside = path.join(allowed, "ok.txt")
    const outside = path.join(sb.work, "outside.txt")
    fs.mkdirSync(allowed)
    const provider = await fakeProvider((_r, n) =>
      [
        { tool: { name: "write", arguments: { path: inside, content: "in" } } },
        { tool: { name: "write", arguments: { path: outside, content: "out" } } },
        { tool: { name: "shell", arguments: { command: "touch shell-marker" } } },
        { text: "done" },
      ][n] ?? { text: "done" },
    )
    const host = await startPluginHost(
      sb,
      { context: { extensionDir: null }, permission: { // edit resources are relative to the session's location directory
        grants: [{ action: "edit", resource: "allowed/**", effect: "allow" }] } },
      {},
      { models: { fetch: false }, fs: { filewatcher: false, fff: false }, config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(provider.providerConfig(["m"])) } },
    )
    const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
    const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "p", location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) }))
    await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) })
    await waitFor(() => provider.requests.length >= 4, { what: "three tool calls and the final answer", timeoutMs: 60_000 })
    provider.stop()
    expect(fs.readFileSync(inside, "utf8")).toBe("in")
    expect(fs.existsSync(outside)).toBe(false)
    expect(fs.existsSync(path.join(sb.work, "shell-marker"))).toBe(false)
  }, 120_000)
})
