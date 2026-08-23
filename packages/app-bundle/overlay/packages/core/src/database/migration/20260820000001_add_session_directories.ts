import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820000001_add_session_directories",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session ADD COLUMN directories TEXT;`)
    })
  },
} satisfies DatabaseMigration.Migration
