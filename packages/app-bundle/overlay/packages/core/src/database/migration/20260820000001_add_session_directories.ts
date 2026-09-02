import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820000001_add_session_directories",
  up(tx) {
    return Effect.gen(function* () {
      // Idempotence guard (harmoniqs/opencode#270): a long-lived production
      // database can carry the `directories` column WITHOUT this journal row
      // (an earlier binary lineage added it out-of-band, or the journal and
      // schema drifted apart) — and the runner can then replay this migration
      // on boot. An unguarded ADD COLUMN turns that drift into an
      // unrecoverable boot crash-loop. Skip when the column already exists;
      // the runner records the journal row either way, so the next boot sees
      // a reconciled journal and the drift self-heals instead of crashing.
      const columns = yield* tx.all<{ name: string }>(sql`PRAGMA table_info(session)`)
      if (columns.some((column) => column.name === "directories")) return
      yield* tx.run(`ALTER TABLE session ADD COLUMN directories TEXT;`)
    })
  },
} satisfies DatabaseMigration.Migration
