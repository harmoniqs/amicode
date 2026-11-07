import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011215119_runtime_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_busy\` (
          \`session_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`directory\` text,
          \`pid\` integer NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`conflict\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`runtime_busy_pk\` PRIMARY KEY(\`session_id\`, \`owner_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_pending\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`directory\` text,
          \`owner_id\` text NOT NULL,
          \`pid\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`data\` text NOT NULL,
          \`resolution\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_session_owner\` (
          \`session_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`directory\` text,
          \`pid\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_heartbeat\` integer NOT NULL,
          \`conflict\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`runtime_session_owner_pk\` PRIMARY KEY(\`session_id\`, \`owner_id\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`runtime_busy_session_idx\` ON \`runtime_busy\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`runtime_pending_kind_state_idx\` ON \`runtime_pending\` (\`kind\`,\`state\`,\`time_heartbeat\`);`,
      )
      yield* tx.run(`CREATE INDEX \`runtime_pending_session_idx\` ON \`runtime_pending\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`runtime_session_owner_session_idx\` ON \`runtime_session_owner\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
