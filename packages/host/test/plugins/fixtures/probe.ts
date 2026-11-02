// A plugin that reports its lifecycle to a file, to prove a real host process loads and unloads plugins.
import fs from "node:fs"
import type { Plugin } from "@opencode/plugin"

const log = (line: string) => fs.appendFileSync(process.env.PROBE_FILE!, line + "\n")

export default {
  id: "test.probe",
  setup: async (context) => {
    log("setup")
    await context.session.hook("context", (input) => log(`context agent=${input.agent}`))
    return () => log("cleanup")
  },
} satisfies Plugin
