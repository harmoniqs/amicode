import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Shared runtime-state rows (#1760 P2). These are EPHEMERAL LIVENESS CLAIMS,
 * deliberately not foreign-keyed to durable tables: they describe which
 * process currently holds runtime truth (busy, pending question, pending
 * permission, coordinator registration), and the TTL heartbeat is their
 * cleanup mechanism — a claim outlives its owner by at most TTL_MS.
 */

/** One (session, owning process) execution claim. Two live rows for one session = double ownership (the ghost). */
export const RuntimeBusyTable = sqliteTable(
  "runtime_busy",
  {
    session_id: text().notNull(),
    owner_id: text().notNull(),
    directory: text(),
    pid: integer().notNull(),
    time_started: integer().notNull(),
    time_heartbeat: integer().notNull(),
    /** Advisory ghost marker: set when this row's writer observed a live claim from another owner. */
    conflict: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.owner_id] }),
    index("runtime_busy_session_idx").on(table.session_id),
  ],
)

/** Coordinator registration: sessionID → owner identity. Written when a process's coordinator lazily adopts/starts a session. */
export const RuntimeSessionOwnerTable = sqliteTable(
  "runtime_session_owner",
  {
    session_id: text().notNull(),
    owner_id: text().notNull(),
    directory: text(),
    pid: integer().notNull(),
    time_created: integer().notNull(),
    time_heartbeat: integer().notNull(),
    conflict: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.owner_id] }),
    index("runtime_session_owner_session_idx").on(table.session_id),
  ],
)

/** Pending question/permission requests, mirrored from per-instance memory so any component can list/resolve them. */
export const RuntimePendingTable = sqliteTable(
  "runtime_pending",
  {
    id: text().primaryKey(),
    kind: text().$type<"question" | "permission">().notNull(),
    session_id: text().notNull(),
    directory: text(),
    owner_id: text().notNull(),
    pid: integer().notNull(),
    state: text().$type<"pending" | "replied" | "rejected">().notNull(),
    /** Full request payload (QuestionV1.Request / PermissionV1.Request shape). */
    data: text({ mode: "json" }).notNull(),
    /** Answers / reply payload when resolved from a mis-routed component. */
    resolution: text({ mode: "json" }),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_heartbeat: integer().notNull(),
  },
  (table) => [
    index("runtime_pending_kind_state_idx").on(table.kind, table.state, table.time_heartbeat),
    index("runtime_pending_session_idx").on(table.session_id),
  ],
)
