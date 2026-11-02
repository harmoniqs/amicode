import { afterAll, describe, expect, test } from "bun:test"
import { cleanup, makeSandbox, waitFor } from "../helpers.ts"
import { fakeProvider } from "./fake-provider.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

describe("scaffold", () => {
  test("a turn against the loopback provider completes and the request is recorded", async () => {
    const sb = makeSandbox("plug-turn")
    const provider = await fakeProvider()
    const host = await startPluginHost(sb, {}, {}, {
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(provider.providerConfig(["qwen-test"])) },
    })
    const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
    const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "t", location: { directory: sb.work }, model: { providerID: "fake", id: "qwen-test" } }) }))
    const id = created.data.id
    const prompted = await fetch(`${host.url}/api/session/${id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) })
    console.log(prompted.status, (await prompted.text()).slice(0, 300))
    await waitFor(() => provider.requests.length > 0, { what: "a provider request", timeoutMs: 30_000 })
    console.log(JSON.stringify(provider.requests[0], null, 1).slice(0, 3000))
    provider.stop()
  }, 90_000)
})
