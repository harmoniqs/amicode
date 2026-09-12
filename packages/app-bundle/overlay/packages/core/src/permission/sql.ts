import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import type { PermissionSaved } from "./saved"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)

export const ProviderPermissionTable = sqliteTable(
  "provider_permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    tier_id: text().notNull(),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("provider_permission_project_tier_action_resource_idx").on(
      table.project_id,
      table.tier_id,
      table.action,
      table.resource,
    ),
  ],
)
