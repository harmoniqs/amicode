import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828201050_normal_stryfe",
  up(tx) {
    return Effect.gen(function* () {
      // Idempotence guard (harmoniqs/opencode#270): this migration duplicates
      // 20260820000001_add_session_directories (both add `session.directories`).
      // Databases bootstrapped by a #215-era binary carry the column AND the
      // older journal row but NOT this row — an unguarded ADD COLUMN made every
      // post-duplicate binary crash-loop on such databases at boot (observed on
      // the erlich hub 2026-08-30: exit ~1s, 29 systemd restarts). Skip when the
      // column exists; the runner records the row either way so the journal
      // reconciles and subsequent boots are clean.
      const columns = yield* tx.all<{ name: string }>(sql`PRAGMA table_info(session)`)
      if (columns.some((column) => column.name === "directories")) return
      yield* tx.run(`ALTER TABLE \`session\` ADD \`directories\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
