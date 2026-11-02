// Contract: the PUBLISHED `@opencode/client` (the client the SDK, and so the Amicode extension, speaks) against
// our host: Basic auth through the front, server info, session create/list, plugin list and the event stream.
// The client is resolved the way the SDK resolves it (a dependency of the pinned `@opencode/sdk`), because the
// host itself does not import it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanupContract, contractSandbox, packageRoot, startContractHost, stopContractHost, type ContractHost } from "./support.ts"

afterAll(cleanupContract)

const sb = contractSandbox("client")
let host: ContractHost
let client: any

beforeAll(async () => {
  host = await startContractHost(sb)
  const sdkDir = fs.realpathSync(path.join(packageRoot, "node_modules/@opencode/sdk"))
  const clientEntry = Bun.resolveSync("@opencode/client", sdkDir)
  const { OpenCode } = (await import(clientEntry)) as { OpenCode: { make: (options: unknown) => unknown } }
  client = OpenCode.make({ baseUrl: host.url, headers: host.headers })
}, 90_000)
afterAll(async () => {
  if (host) await stopContractHost(host)
})

describe("contract: @opencode/client against the host", () => {
  test("exports OpenCode.make, which builds a client with the namespaces the extension uses", () => {
    for (const namespace of ["server", "session", "plugin", "event", "agent", "location"]) expect(typeof client[namespace]).toBe("object")
    expect(typeof client.server.info).toBe("function")
    expect(typeof client.session.create).toBe("function")
    expect(typeof client.session.list).toBe("function")
    expect(typeof client.event.subscribe).toBe("function")
  })

  test("server.info() decodes the host's /api/info", async () => {
    const info = await client.server.info()
    expect(info).toMatchObject({ version: expect.any(String), pid: host.proc.pid, capabilities: expect.any(Object) })
  })

  test("session.create() then session.list() round-trips through the host", async () => {
    const created = await client.session.create({ title: "client-contract", location: { directory: sb.work } })
    const id = created.id as string
    expect(id).toMatch(/^ses_/)
    expect(created.title).toBe("client-contract")
    const listed = await client.session.list()
    const sessions = (listed.data ?? listed) as { id: string }[]
    expect(sessions.map((s) => s.id)).toContain(id)
  })

  test("plugin.list() answers an array", async () => {
    const listed = await client.plugin.list()
    expect(Array.isArray(listed.data ?? listed)).toBe(true)
  })

  test("event.subscribe() yields server.connected first and ends when aborted", async () => {
    const controller = new AbortController()
    const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    const first = await Promise.race([iterator.next(), Bun.sleep(10_000).then(() => "timeout")])
    expect(first).not.toBe("timeout")
    expect((first as IteratorResult<{ type: string }>).value).toMatchObject({ type: "server.connected" })
    controller.abort()
    await iterator.return?.()
  })

  test("a wrong password is rejected at the front, not decoded as data", async () => {
    const { OpenCode } = (await import(Bun.resolveSync("@opencode/client", fs.realpathSync(path.join(packageRoot, "node_modules/@opencode/sdk"))))) as { OpenCode: { make: (options: unknown) => any } }
    const stranger = OpenCode.make({ baseUrl: host.url, headers: { authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") } })
    await expect(stranger.server.info()).rejects.toBeDefined()
  })
})
