// Shared by the plugin tests: starting a sandboxed host with a plugin config, and the tiny HTTP helpers.
import net from "node:net"
import { ready, spawnHost, type Sandbox } from "../helpers.ts"

export const PLUGIN_PORT_MIN = 52100
export const PLUGIN_PORT_MAX = 52199

export const json = async (res: Response) => (await res.json()) as any
export const dirHeader = (sb: Sandbox) => ({ "x-opencode-directory": sb.work })

/** A free loopback port inside this slice's assigned range. */
export async function pluginPort() {
  for (let i = 0; i < 200; i++) {
    const port = PLUGIN_PORT_MIN + Math.floor(Math.random() * (PLUGIN_PORT_MAX - PLUGIN_PORT_MIN + 1))
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error("no free port in the plugin test range")
}

export async function startPluginHost(
  sb: Sandbox,
  pluginConfig: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  serverOptions?: Record<string, unknown>,
) {
  const host = spawnHost(sb, {
    port: await pluginPort(),
    env: {
      AMICODE_HOST_PLUGIN_CONFIG: JSON.stringify(pluginConfig),
      ...(serverOptions ? { AMICODE_HOST_SERVER_OPTIONS: JSON.stringify(serverOptions) } : {}),
      ...env,
    },
  })
  await ready(host)
  return host
}
