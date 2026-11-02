// Restart with a pending permission and with a pending question (#2062). Observed against real host processes,
// recorded here as the contract:
//
//  * Pending permission requests and pending question forms live in the process (a Map / the form service); they are
//    NOT persisted. On a graceful stop (SIGTERM) they are cancelled and the waiting tool call is terminalized with
//    an `aborted` error ("Interaction cancelled because the location shut down") — a visible failure, not a hang.
//  * The turn itself is durable: the session's execution claim survives, and the next host start RESUMES it — it
//    admits a "The server restarted while you were working…" notice and runs a NEW model turn that sees the aborted
//    tool result. The cancelled tool is neither re-executed nor re-asked: no approval is ever inferred.
//  * After a hard kill (SIGKILL) nothing was cancelled by the dying process, but the outcome is the same: the new
//    process resumes the session with the notice, the dangling tool call is terminalized on resume ("Tool execution
//    interrupted: shell"), and the old request is gone (never answerable, never applied).
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanup, makeSandbox, stop, waitFor, type Sandbox, type SpawnedHost } from "../helpers.ts"
import { fakeProvider, type Reply } from "./fake-provider.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

type Kind = "permission" | "question"
const call = (kind: Kind, marker: string): Reply =>
  kind === "permission"
    ? { tool: { name: "shell", arguments: { command: `touch ${marker}` } } }
    : { tool: { name: "question", arguments: { questions: [{ question: "Proceed?", header: "Go", options: [{ label: "yes", description: "y" }, { label: "no", description: "n" }] }] } } }

async function scenario(kind: Kind, how: "graceful" | "killed") {
  const sb = makeSandbox(`restart-${kind}-${how}`)
  const marker = path.join(sb.work, "must-not-exist")
  const provider = await fakeProvider((_r, n) => (n === 0 ? call(kind, marker) : { text: "resumed" }))
  // everything is granted by the host policy except that a shell command must be approved by a person
  const pluginConfig = { context: { extensionDir: null }, permission: { replaceDefaults: true, grants: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }] } }
  const serverOptions = { models: { fetch: false }, fs: { filewatcher: false, fff: false }, config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(provider.providerConfig(["m"])) } }
  const authed = (host: SpawnedHost) => ({ ...host.auth, ...dirHeader(sb), "content-type": "application/json" })
  const get = async (host: SpawnedHost, p: string) => json(await fetch(host.url + p, { headers: authed(host) }))
  const pending = async (host: SpawnedHost) => (kind === "permission" ? (await get(host, "/api/permission/request")).data : (await get(host, "/api/form")).data) as unknown[]

  const first = await startPluginHost(sb, pluginConfig, {}, serverOptions)
  const created = await json(await fetch(first.url + "/api/session", { method: "POST", headers: authed(first), body: JSON.stringify({ title: "p", location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) }))
  const id: string = created.data.id
  await fetch(`${first.url}/api/session/${id}/prompt`, { method: "POST", headers: authed(first), body: JSON.stringify({ text: "go" }) })
  await waitFor(async () => (await pending(first)).length === 1, { what: `a pending ${kind}`, timeoutMs: 30_000 })
  const before = { pending: (await pending(first)).length, running: (await get(first, "/api/session/active")).data[id]?.type, requests: provider.requests.length }

  if (how === "graceful") expect(await stop(first)).toBe(0)
  else {
    first.proc.kill("SIGKILL")
    await first.exited
  }
  const second = await startPluginHost(sb, pluginConfig, {}, serverOptions)
  await waitFor(async () => (await get(second, `/api/session/${id}`)).data.outcome !== undefined, { what: "the resumed turn to finish", timeoutMs: 45_000 })
  const messages = JSON.stringify((await get(second, `/api/session/${id}/message`)).data)
  const resumedRequest = JSON.stringify(provider.requests[1]?.body.messages.filter((m: any) => m.role !== "system"))
  const after = { pending: (await pending(second)).length, outcome: (await get(second, `/api/session/${id}`)).data.outcome, requests: provider.requests.length }
  provider.stop()
  return { sb, marker, before, after, messages, resumedRequest }
}

describe.each(["permission", "question"] as const)("restart with a pending %s", (kind) => {
  test("graceful: the request is cancelled visibly, the turn is resumed with a restart notice, nothing is re-asked or executed", async () => {
    const r = await scenario(kind, "graceful")
    expect(r.before).toEqual({ pending: 1, running: "running", requests: 1 })
    expect(r.after.pending).toBe(0) // not carried across the restart: nothing left to answer, nothing silently approved
    expect(r.resumedRequest).toContain("Interaction cancelled because the location shut down") // the waiting tool call failed visibly
    expect(r.resumedRequest).toContain("The server restarted while you were working")
    expect(r.messages).toContain('"notice":"restart"')
    expect(r.after).toMatchObject({ outcome: "succeeded", requests: 2 }) // resumed: exactly one new model turn
    expect(fs.existsSync(r.marker)).toBe(false) // an unapproved command never ran
  }, 150_000)
})

describe("restart after a hard kill with a pending permission", () => {
  test("SIGKILL: the next start resumes the session with the restart notice; the lost request is gone and the command never ran", async () => {
    const r = await scenario("permission", "killed")
    expect(r.resumedRequest).toContain("Tool execution interrupted: shell") // terminalized on resume instead
    expect(r.before).toEqual({ pending: 1, running: "running", requests: 1 })
    expect(r.after.pending).toBe(0)
    expect(r.resumedRequest).toContain("The server restarted while you were working")
    expect(r.after.outcome).toBe("succeeded")
    expect(fs.existsSync(r.marker)).toBe(false)
  }, 150_000)
})
