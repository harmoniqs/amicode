// H0b spike driver (not part of upstream): builds the Database layer on $OPENCODE_DB and runs the V1 migration.
import { Database } from "@opencode/core/database/database"
import { V1Migration } from "@opencode/core/database/v1-migration"
import { Project } from "@opencode/core/project"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import fs from "node:fs"

const file = process.env.OPENCODE_DB
if (!file || !file.startsWith("/tmp/opencode/h0b/")) throw new Error("OPENCODE_DB must point at the copy under /tmp/opencode/h0b/")
const data = process.env.XDG_DATA_HOME + "/opencode"
fs.mkdirSync(data, { recursive: true })
const global = Global.make({ data })
console.error(JSON.stringify({ runtime: process.versions.bun ? "bun " + process.versions.bun : "node " + process.version, db: file, data }))

const program = Effect.gen(function* () {
  const t0 = Date.now()
  const before = yield* V1Migration.status()
  console.error(JSON.stringify({ phase: "status-before", before, ms: Date.now() - t0 }))
  const result = yield* V1Migration.run()
  console.error(JSON.stringify({ phase: "run-done", result, ms: Date.now() - t0 }))
  const after = yield* V1Migration.status()
  console.error(JSON.stringify({ phase: "status-after", after, ms: Date.now() - t0 }))
})

await Effect.runPromise(
  Effect.scoped(
    program.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, FSUtil.node]), [
          Database.node.replace(Database.layer({ path: file }).pipe(Layer.provide(Layer.succeed(Global.Service, global)))),
        ]),
      ),
      Effect.provideService(Global.Service, global),
    ),
  ),
)
console.error(JSON.stringify({ phase: "exit-ok", maxRssKB: Math.round(process.resourceUsage().maxRSS) }))
process.exit(0)
