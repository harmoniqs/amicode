import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813162312_shocking_karnak",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`tier_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_provider_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`provider_permission_project_tier_action_resource_idx\` ON \`provider_permission\` (\`project_id\`,\`tier_id\`,\`action\`,\`resource\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
