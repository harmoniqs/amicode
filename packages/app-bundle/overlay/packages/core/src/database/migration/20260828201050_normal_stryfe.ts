import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828201050_normal_stryfe",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`directories\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
