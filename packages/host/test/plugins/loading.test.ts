// Plugins reach the engine through the seam: a real host process, a plugin module named in the plugin config, and
// the engine's own plugin runtime calling its setup. Ports 52100-52199.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanup, makeSandbox, ready, spawnHost, stop, waitFor } from "../helpers.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

describe("plugin loading through the seam", () => {
  test("a configured plugin module is set up when the first location boots, and cleaned up on shutdown", async () => {
    const sb = makeSandbox("plug-load")
    const probe = path.join(sb.root, "probe.log")
    const host = await startPluginHost(sb, { modules: [path.resolve(import.meta.dir, "fixtures/probe.ts")] }, { PROBE_FILE: probe })
    const created = await fetch(host.url + "/api/session", {
      method: "POST",
      headers: { ...host.auth, ...dirHeader(sb), "content-type": "application/json" },
      body: JSON.stringify({ title: "plugin-load", location: { directory: sb.work } }),
    })
    expect(created.status).toBe(200)
    await json(created)
    // creating a session does not boot the location's services; the first location-scoped read does
    expect((await fetch(host.url + "/api/agent", { headers: { ...host.auth, ...dirHeader(sb) } })).status).toBe(200)
    await waitFor(() => fs.existsSync(probe) && fs.readFileSync(probe, "utf8").includes("setup"), { what: "the probe plugin's setup" })
    expect(await stop(host)).toBe(0)
    expect(fs.readFileSync(probe, "utf8")).toContain("cleanup")
  }, 90_000)

  test("a malformed plugin config refuses to start (exit 64 naming the variable), never silently serving without policy", async () => {
    const sb = makeSandbox("plug-bad")
    const host = spawnHost(sb, { port: 0, env: { AMICODE_HOST_PLUGIN_CONFIG: "{not json" } })
    const code = await Promise.race([host.exited, Bun.sleep(30_000).then(() => "timeout" as const)])
    expect(code).not.toBe("timeout")
    expect(code).not.toBe(0)
    expect(host.output.stderr).toContain("AMICODE_HOST_PLUGIN_CONFIG")
  }, 60_000)
})
