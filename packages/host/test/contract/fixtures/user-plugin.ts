// A user plugin file, loaded by the host through its dynamic import path (AMICODE_HOST_PLUGIN_CONFIG.modules).
// Reports its lifecycle and hook firings to PROBE_FILE; contributes a system-prompt block.
import fs from "node:fs"
import type { Plugin } from "@opencode/plugin"

const log = (line: string) => fs.appendFileSync(process.env.PROBE_FILE!, line + "\n")

export default {
  id: "contract.user-plugin",
  setup: async (context) => {
    log("setup")
    const registrations = [
      await context.session.hook("context", (request) => {
        log(`context agent=${request.agent}`)
        request.system.push({ type: "text", text: "USER-PLUGIN-CONTEXT" })
      }),
      await context.permission.hook("evaluate", (event) => void log(`evaluate ${event.action}`)),
    ]
    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
      log("cleanup")
    }
  },
} satisfies Plugin.Plugin
