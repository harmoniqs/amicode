import { Database } from "@opencode-ai/core/database/database"
import { SessionLineageOriginTable, SessionLineageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { SessionID } from "./schema"

export namespace SessionLineage {
  export type Mode = "legacy" | "partial" | "full"
  export type EdgeKind = "task_spawn" | "session_spawn"
  export type Origin = {
    sessionID: SessionID
    title: string
    edgeKind: EdgeKind
    deletedAt: number
  }
  export type Descendant = {
    sessionID: SessionID
    parentID: SessionID
    title: string
    edgeKind: EdgeKind
    mode: Exclude<Mode, "legacy">
  }
  export type Info =
    | { mode: "legacy"; rootID: undefined; root: undefined; descendants: []; retainedOrigins: Origin[] }
    | {
        mode: Exclude<Mode, "legacy">
        rootID: SessionID
        root: { sessionID: SessionID; title: string }
        legacyParentID?: SessionID
        descendants: Descendant[]
        retainedOrigins: Origin[]
      }

  export function register(
    database: Database.Interface,
    input: { sessionID: SessionID; parentID?: SessionID; edgeKind?: EdgeKind },
  ) {
    return Effect.gen(function* () {
      if (!input.parentID) {
        yield* database.db
          .insert(SessionLineageTable)
          .values({ session_id: input.sessionID, root_id: input.sessionID, mode: "full" })
          .run()
          .pipe(Effect.orDie)
        return
      }

      const parent = yield* database.db
        .select()
        .from(SessionLineageTable)
        .where(eq(SessionLineageTable.session_id, input.parentID))
        .get()
        .pipe(Effect.orDie)
      if (!parent) {
        // Auto-create a lineage row for the legacy parent (idempotent)
        yield* database.db
          .insert(SessionLineageTable)
          .values({ session_id: input.parentID, root_id: input.parentID, mode: "full" })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        // Register child normally — edge_kind preserved
        yield* database.db
          .insert(SessionLineageTable)
          .values({
            session_id: input.sessionID,
            root_id: input.parentID,
            parent_id: input.parentID,
            edge_kind: input.edgeKind ?? "session_spawn",
            mode: "full",
          })
          .run()
          .pipe(Effect.orDie)

        // Self-heal existing orphaned siblings under the same legacy parent
        yield* database.db
          .update(SessionLineageTable)
          .set({
            root_id: input.parentID,
            parent_id: input.parentID,
            edge_kind: sql`COALESCE(${SessionLineageTable.edge_kind}, 'task_spawn')`,
          })
          .where(
            and(
              eq(SessionLineageTable.legacy_parent_id, input.parentID),
              isNull(SessionLineageTable.parent_id),
            ),
          )
          .run()
          .pipe(Effect.orDie)

        return
      }
      if (parent.mode === "legacy")
        return yield* Effect.die(`Invalid persisted lineage mode for ${input.parentID}`)

      yield* database.db
        .insert(SessionLineageTable)
        .values({
          session_id: input.sessionID,
          root_id: parent.root_id,
          mode: parent.mode,
          parent_id: input.parentID,
          edge_kind: input.edgeKind ?? "session_spawn",
        })
        .run()
        .pipe(Effect.orDie)
    })
  }

  /** Opens the explicit partial epoch for a legacy session; it never backfills history. */
  export function beginPartial(database: Database.Interface, sessionID: SessionID, boundary = Date.now()) {
    return Effect.gen(function* () {
      const existing = yield* database.db
        .select()
        .from(SessionLineageTable)
        .where(eq(SessionLineageTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (existing) return
      yield* database.db
        .insert(SessionLineageTable)
        .values({ session_id: sessionID, root_id: sessionID, mode: "partial", epoch_started_at: boundary })
        .run()
        .pipe(Effect.orDie)
    })
  }

  export function get(
    database: Database.Interface,
    sessionID: SessionID,
    options?: { retainedOrigins?: boolean },
  ) {
    return Effect.gen(function* () {
      const lineage = yield* database.db
        .select()
        .from(SessionLineageTable)
        .where(eq(SessionLineageTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!lineage)
        return {
          mode: "legacy",
          rootID: undefined,
          root: undefined,
          descendants: [],
          retainedOrigins: [],
        } satisfies Info
      if (lineage.mode === "legacy") return yield* Effect.die(`Invalid persisted lineage mode for ${sessionID}`)

      const root = yield* database.db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, lineage.root_id))
        .get()
        .pipe(Effect.orDie)
      if (!root) return yield* Effect.die(`Missing lineage root: ${lineage.root_id}`)

      const descendants = yield* database.db
        .select({ lineage: SessionLineageTable, session: SessionTable })
        .from(SessionLineageTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionLineageTable.session_id))
        .where(and(eq(SessionLineageTable.root_id, lineage.root_id), isNull(SessionTable.time_archived)))
        .all()
        .pipe(Effect.orDie)
      const retainedOrigins = options?.retainedOrigins
        ? yield* database.db
            .select()
            .from(SessionLineageOriginTable)
            .where(eq(SessionLineageOriginTable.root_id, lineage.root_id))
            .all()
            .pipe(Effect.orDie)
        : []
      return {
        mode: lineage.mode,
        rootID: lineage.root_id,
        root: { sessionID: root.id, title: root.title },
        ...(lineage.legacy_parent_id ? { legacyParentID: lineage.legacy_parent_id } : {}),
        descendants: descendants.flatMap((item) => {
          if (
            item.lineage.session_id === lineage.root_id ||
            !item.lineage.parent_id ||
            !item.lineage.edge_kind ||
            item.lineage.mode === "legacy"
          )
            return []
          return [
            {
              sessionID: item.lineage.session_id,
              parentID: item.lineage.parent_id,
              title: item.session.title,
              edgeKind: item.lineage.edge_kind,
              mode: item.lineage.mode,
            },
          ]
        }),
        retainedOrigins: retainedOrigins.map((origin) => ({
          sessionID: origin.session_id,
          title: origin.title,
          edgeKind: origin.edge_kind,
          deletedAt: origin.deleted_at,
        })),
      } satisfies Info
    })
  }

  export function retainBeforeDelete(database: Database.Interface, input: { sessionID: SessionID; title: string }) {
    return Effect.gen(function* () {
      const lineage = yield* database.db
        .select()
        .from(SessionLineageTable)
        .where(eq(SessionLineageTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!lineage) return
      if (lineage.root_id === input.sessionID) {
        yield* database.db
          .delete(SessionLineageOriginTable)
          .where(eq(SessionLineageOriginTable.root_id, input.sessionID))
          .run()
          .pipe(Effect.orDie)
        return
      }
      if (!lineage.edge_kind) return
      yield* database.db
        .insert(SessionLineageOriginTable)
        .values({
          root_id: lineage.root_id,
          session_id: input.sessionID,
          title: input.title,
          edge_kind: lineage.edge_kind,
          deleted_at: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })
  }

  /** One-time repair for orphaned lineage entries created before the Bug A fix. */
  export function repairOrphanedEntries(database: Database.Interface) {
    return Effect.gen(function* () {
      // Find all orphaned entries (have legacy_parent_id but no parent_id)
      const orphans = yield* database.db
        .select({
          legacy_parent_id: SessionLineageTable.legacy_parent_id,
        })
        .from(SessionLineageTable)
        .where(
          and(
            isNull(SessionLineageTable.parent_id),
            isNotNull(SessionLineageTable.legacy_parent_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      // Get unique parent IDs
      const parentIDs = [...new Set(
        orphans
          .map((row) => row.legacy_parent_id)
          .filter((id): id is SessionID => id != null),
      )]

      for (const parentID of parentIDs) {
        // Ensure the parent has a lineage row
        yield* database.db
          .insert(SessionLineageTable)
          .values({ session_id: parentID, root_id: parentID, mode: "full" })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        // Repair orphaned children
        yield* database.db
          .update(SessionLineageTable)
          .set({
            root_id: parentID,
            parent_id: parentID,
            edge_kind: sql`COALESCE(${SessionLineageTable.edge_kind}, 'task_spawn')`,
          })
          .where(
            and(
              eq(SessionLineageTable.legacy_parent_id, parentID),
              isNull(SessionLineageTable.parent_id),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }
    })
  }
}
