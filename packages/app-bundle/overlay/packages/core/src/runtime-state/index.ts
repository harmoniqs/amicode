export * as RuntimeState from "./index"

import { and, eq, gt, lt, ne, or } from "drizzle-orm"
import { Clock, Context, Effect, Exit, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { runID } from "../observability/shared"
import { RuntimeBusyTable, RuntimePendingTable, RuntimeSessionOwnerTable } from "./sql"

/**
 * Shared runtime-state store (#1760 P2): busy, pending questions, pending
 * permissions, and coordinator registration become shared rows with TTL
 * heartbeats, so ANY component can answer "where is this, and is it alive".
 *
 * The in-memory fast paths stay authoritative for execution (execution is
 * process-local per the V2 Session Core invariants); these rows are the
 * cross-component TRUTH for location + liveness. Hooks into the fast paths
 * run their store writes through `RuntimeState.bestEffort` — a store failure
 * degrades to the pre-store behavior, never breaks the memory path.
 */

/** Owning processes re-stamp their rows at this cadence. */
export const HEARTBEAT_INTERVAL_MS = 5_000
/** Rows whose heartbeat is older than 3x the cadence read as dead. */
export const TTL_MS = 3 * HEARTBEAT_INTERVAL_MS
/** How often an owner re-reads its pending rows for resolutions recorded by another component. */
export const RECONCILE_INTERVAL_MS = 1_000

export type PendingKind = "question" | "permission"
export type PendingState = "pending" | "replied" | "rejected"

export interface Owner {
  readonly owner_id: string
  readonly pid: number
}

/** This process's identity, shared by every row it writes. */
export const self: Owner = { owner_id: runID, pid: process.pid }

export interface BusyRow {
  readonly session_id: string
  readonly owner_id: string
  readonly directory: string | null
  readonly pid: number
  readonly time_started: number
  readonly time_heartbeat: number
  readonly conflict: boolean
}

export interface OwnerRow {
  readonly session_id: string
  readonly owner_id: string
  readonly directory: string | null
  readonly pid: number
  readonly time_created: number
  readonly time_heartbeat: number
  readonly conflict: boolean
}

export interface PendingRow {
  readonly kind: PendingKind
  readonly id: string
  readonly session_id: string
  readonly directory: string | null
  readonly owner_id: string
  readonly pid: number
  readonly state: PendingState
  readonly data: unknown
  readonly resolution: unknown
  readonly time_created: number
  readonly time_updated: number
  readonly time_heartbeat: number
}

export interface Interface {
  /** Claims the session as executing for this owner; stamps the coordinator registration too. */
  readonly busyEnter: (input: {
    readonly sessionID: string
    readonly directory?: string | null
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /** Re-stamps the busy + registration rows for this owner. */
  readonly busyHeartbeat: (input: {
    readonly sessionID: string
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /** Releases the busy claim (the registration row expires on its own). */
  readonly busyExit: (input: {
    readonly sessionID: string
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /** Live busy rows for a session, any owner — more than one is double ownership. */
  readonly busyLive: (sessionID: string) => Effect.Effect<ReadonlyArray<BusyRow>>

  /** Registers the coordinator's claim on a session (ghost visibility at lazy adoption). */
  readonly register: (input: {
    readonly sessionID: string
    readonly directory?: string | null
    readonly owner?: Owner
  }) => Effect.Effect<void>
  readonly unregister: (input: { readonly sessionID: string; readonly owner?: Owner }) => Effect.Effect<void>
  /** Live coordinator registrations for a session, any owner. */
  readonly ownersLive: (sessionID: string) => Effect.Effect<ReadonlyArray<OwnerRow>>

  /** Mirrors a pending question/permission request into the store. */
  readonly recordPending: (input: {
    readonly kind: PendingKind
    readonly id: string
    readonly sessionID: string
    readonly directory?: string | null
    readonly data: unknown
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /** Re-stamps a pending row's heartbeat. */
  readonly heartbeatPending: (input: {
    readonly kind: PendingKind
    readonly id: string
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /**
   * Resolves a pending row. Idempotent: true only when a pending row was
   * settled; a replay against an already-settled row returns false and keeps
   * the recorded resolution.
   */
  readonly settlePending: (input: {
    readonly kind: PendingKind
    readonly id: string
    readonly state: "replied" | "rejected"
    readonly resolution?: unknown
  }) => Effect.Effect<boolean>
  /** Removes the owner's row while it is still pending — the ask-exit cleanup. */
  readonly discardPending: (input: {
    readonly kind: PendingKind
    readonly id: string
    readonly owner?: Owner
  }) => Effect.Effect<void>
  /** The row as a fact, regardless of heartbeat freshness. */
  readonly getPending: (kind: PendingKind, id: string) => Effect.Effect<PendingRow | undefined>
  /** All live (fresh-heartbeat, state=pending) rows of one kind, any owner. */
  readonly livePending: (kind: PendingKind) => Effect.Effect<ReadonlyArray<PendingRow>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/RuntimeState") {}

/** Store ops must never break the in-memory fast path: failures degrade to memory-only. */
export function bestEffort<A>(effect: Effect.Effect<A>): Effect.Effect<A | undefined> {
  return effect.pipe(
    Effect.exit,
    Effect.tap((exit) =>
      Exit.isFailure(exit)
        ? Effect.logWarning("RuntimeState: shared-store op failed (degraded to memory-only)", {
            cause: exit.cause,
          })
        : Effect.void,
    ),
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
  )
}

export const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Clock.currentTimeMillis
    const fresh = Effect.map(now, (t) => t - TTL_MS)

    /** Prune this session's dead claims on every write — bounded table growth without a sweeper. */
    const pruneDead = Effect.fnUntraced(function* (sessionID: string) {
      const cutoff = yield* fresh
      yield* db
        .delete(RuntimeBusyTable)
        .where(and(eq(RuntimeBusyTable.session_id, sessionID), lt(RuntimeBusyTable.time_heartbeat, cutoff)))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(RuntimeSessionOwnerTable)
        .where(
          and(
            eq(RuntimeSessionOwnerTable.session_id, sessionID),
            lt(RuntimeSessionOwnerTable.time_heartbeat, cutoff),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    /** Advisory ghost marker: flag every live claim when two owners hold the same session. */
    const flagConflict = Effect.fnUntraced(function* (
      sessionID: string,
      owner: Owner,
      table: typeof RuntimeBusyTable | typeof RuntimeSessionOwnerTable,
    ) {
      const cutoff = yield* fresh
      const others = yield* db
        .select({ owner_id: table.owner_id })
        .from(table)
        .where(
          and(
            eq(table.session_id, sessionID),
            ne(table.owner_id, owner.owner_id),
            gt(table.time_heartbeat, cutoff),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (others.length === 0) return
      yield* Effect.logWarning("RuntimeState: double ownership detected", {
        sessionID,
        owner: owner.owner_id,
        otherOwners: others.map((row) => row.owner_id),
      })
      yield* db
        .update(table)
        .set({ conflict: true })
        .where(and(eq(table.session_id, sessionID), gt(table.time_heartbeat, cutoff)))
        .run()
        .pipe(Effect.orDie)
    })

    const busyEnter = Effect.fn("RuntimeState.busyEnter")(function* (input: {
      sessionID: string
      directory?: string | null
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      const t = yield* now
      yield* pruneDead(input.sessionID)
      yield* db
        .insert(RuntimeBusyTable)
        .values({
          session_id: input.sessionID,
          owner_id: owner.owner_id,
          directory: input.directory ?? null,
          pid: owner.pid,
          time_started: t,
          time_heartbeat: t,
        })
        .onConflictDoUpdate({
          target: [RuntimeBusyTable.session_id, RuntimeBusyTable.owner_id],
          set: { time_heartbeat: t, time_started: t, directory: input.directory ?? null, pid: owner.pid },
        })
        .run()
        .pipe(Effect.orDie)
      // busyEnter re-stamps the coordinator registration: executing implies owning.
      yield* db
        .insert(RuntimeSessionOwnerTable)
        .values({
          session_id: input.sessionID,
          owner_id: owner.owner_id,
          directory: input.directory ?? null,
          pid: owner.pid,
          time_created: t,
          time_heartbeat: t,
        })
        .onConflictDoUpdate({
          target: [RuntimeSessionOwnerTable.session_id, RuntimeSessionOwnerTable.owner_id],
          set: { time_heartbeat: t, directory: input.directory ?? null, pid: owner.pid },
        })
        .run()
        .pipe(Effect.orDie)
      yield* flagConflict(input.sessionID, owner, RuntimeBusyTable)
      yield* flagConflict(input.sessionID, owner, RuntimeSessionOwnerTable)
    })

    const busyHeartbeat = Effect.fn("RuntimeState.busyHeartbeat")(function* (input: {
      sessionID: string
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      const t = yield* now
      for (const table of [RuntimeBusyTable, RuntimeSessionOwnerTable]) {
        yield* db
          .update(table)
          .set({ time_heartbeat: t })
          .where(and(eq(table.session_id, input.sessionID), eq(table.owner_id, owner.owner_id)))
          .run()
          .pipe(Effect.orDie)
      }
    })

    const busyExit = Effect.fn("RuntimeState.busyExit")(function* (input: {
      sessionID: string
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      yield* db
        .delete(RuntimeBusyTable)
        .where(and(eq(RuntimeBusyTable.session_id, input.sessionID), eq(RuntimeBusyTable.owner_id, owner.owner_id)))
        .run()
        .pipe(Effect.orDie)
    })

    const busyLive = Effect.fn("RuntimeState.busyLive")(function* (sessionID: string) {
      const cutoff = yield* fresh
      return yield* db
        .select()
        .from(RuntimeBusyTable)
        .where(and(eq(RuntimeBusyTable.session_id, sessionID), gt(RuntimeBusyTable.time_heartbeat, cutoff)))
        .all()
        .pipe(Effect.orDie)
    })

    const register = Effect.fn("RuntimeState.register")(function* (input: {
      sessionID: string
      directory?: string | null
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      const t = yield* now
      yield* pruneDead(input.sessionID)
      yield* db
        .insert(RuntimeSessionOwnerTable)
        .values({
          session_id: input.sessionID,
          owner_id: owner.owner_id,
          directory: input.directory ?? null,
          pid: owner.pid,
          time_created: t,
          time_heartbeat: t,
        })
        .onConflictDoUpdate({
          target: [RuntimeSessionOwnerTable.session_id, RuntimeSessionOwnerTable.owner_id],
          set: { time_heartbeat: t, directory: input.directory ?? null, pid: owner.pid },
        })
        .run()
        .pipe(Effect.orDie)
      yield* flagConflict(input.sessionID, owner, RuntimeSessionOwnerTable)
    })

    const unregister = Effect.fn("RuntimeState.unregister")(function* (input: {
      sessionID: string
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      yield* db
        .delete(RuntimeSessionOwnerTable)
        .where(
          and(
            eq(RuntimeSessionOwnerTable.session_id, input.sessionID),
            eq(RuntimeSessionOwnerTable.owner_id, owner.owner_id),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const ownersLive = Effect.fn("RuntimeState.ownersLive")(function* (sessionID: string) {
      const cutoff = yield* fresh
      return yield* db
        .select()
        .from(RuntimeSessionOwnerTable)
        .where(
          and(
            eq(RuntimeSessionOwnerTable.session_id, sessionID),
            gt(RuntimeSessionOwnerTable.time_heartbeat, cutoff),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    })

    const recordPending = Effect.fn("RuntimeState.recordPending")(function* (input: {
      kind: PendingKind
      id: string
      sessionID: string
      directory?: string | null
      data: unknown
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      const t = yield* now
      // Bounded growth without a sweeper: a new request in the same session
      // prunes its rows that are long-settled or whose owner's heartbeat lapsed.
      yield* db
        .delete(RuntimePendingTable)
        .where(
          and(
            eq(RuntimePendingTable.session_id, input.sessionID),
            or(
              and(ne(RuntimePendingTable.state, "pending"), lt(RuntimePendingTable.time_updated, t - TTL_MS)),
              and(eq(RuntimePendingTable.state, "pending"), lt(RuntimePendingTable.time_heartbeat, t - TTL_MS)),
            ),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(RuntimePendingTable)
        .values({
          id: input.id,
          kind: input.kind,
          session_id: input.sessionID,
          directory: input.directory ?? null,
          owner_id: owner.owner_id,
          pid: owner.pid,
          state: "pending",
          data: input.data,
          time_created: t,
          time_updated: t,
          time_heartbeat: t,
        })
        // A replayed ask must never clobber a row another component already settled.
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const heartbeatPending = Effect.fn("RuntimeState.heartbeatPending")(function* (input: {
      kind: PendingKind
      id: string
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      const t = yield* now
      yield* db
        .update(RuntimePendingTable)
        .set({ time_heartbeat: t })
        .where(
          and(
            eq(RuntimePendingTable.kind, input.kind),
            eq(RuntimePendingTable.id, input.id),
            eq(RuntimePendingTable.owner_id, owner.owner_id),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const settlePending = Effect.fn("RuntimeState.settlePending")(function* (input: {
      kind: PendingKind
      id: string
      state: "replied" | "rejected"
      resolution?: unknown
    }) {
      const existing = yield* db
        .select({ state: RuntimePendingTable.state })
        .from(RuntimePendingTable)
        .where(and(eq(RuntimePendingTable.kind, input.kind), eq(RuntimePendingTable.id, input.id)))
        .get()
        .pipe(Effect.orDie)
      if (existing?.state !== "pending") return false
      const t = yield* now
      yield* db
        .update(RuntimePendingTable)
        .set({ state: input.state, resolution: input.resolution, time_updated: t })
        .where(
          and(
            eq(RuntimePendingTable.kind, input.kind),
            eq(RuntimePendingTable.id, input.id),
            eq(RuntimePendingTable.state, "pending"),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return true
    })

    const discardPending = Effect.fn("RuntimeState.discardPending")(function* (input: {
      kind: PendingKind
      id: string
      owner?: Owner
    }) {
      const owner = input.owner ?? self
      // Only a still-pending row goes: a settled row keeps its recorded state
      // so mis-routed replays stay idempotent until the TTL prunes it.
      yield* db
        .delete(RuntimePendingTable)
        .where(
          and(
            eq(RuntimePendingTable.kind, input.kind),
            eq(RuntimePendingTable.id, input.id),
            eq(RuntimePendingTable.owner_id, owner.owner_id),
            eq(RuntimePendingTable.state, "pending"),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const getPending = Effect.fn("RuntimeState.getPending")(function* (kind: PendingKind, id: string) {
      return yield* db
        .select()
        .from(RuntimePendingTable)
        .where(and(eq(RuntimePendingTable.kind, kind), eq(RuntimePendingTable.id, id)))
        .get()
        .pipe(Effect.orDie)
    })

    const livePending = Effect.fn("RuntimeState.livePending")(function* (kind: PendingKind) {
      const cutoff = yield* fresh
      return yield* db
        .select()
        .from(RuntimePendingTable)
        .where(
          and(
            eq(RuntimePendingTable.kind, kind),
            eq(RuntimePendingTable.state, "pending"),
            gt(RuntimePendingTable.time_heartbeat, cutoff),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    })

    return Service.of({
      busyEnter,
      busyHeartbeat,
      busyExit,
      busyLive,
      register,
      unregister,
      ownersLive,
      recordPending,
      heartbeatPending,
      settlePending,
      discardPending,
      getPending,
      livePending,
    })
  }),
)

// ── Process-global handle ──────────────────────────────────────────────────
// Hooks in services that predate the shared store (V1 question/permission/
// status, the V2 execution coordinator) cannot take it as a layer dependency
// without dragging the shared Database into every unit-test graph. They read
// it through this handle instead: any environment that builds `layer`/`node`
// registers the handle, and store-less environments simply skip the mirroring.

let handle: Interface | undefined

export function getGlobal(): Interface | undefined {
  return handle
}

/**
 * The store layer, wrapped to register the process-global handle on
 * construction and restore the previous one on close.
 */
const registration = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* Service
    const previous = handle
    handle = service
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (handle === service) handle = previous
      }),
    )
  }),
)

export const layer = Layer.provideMerge(registration, serviceLayer)

export const locationLayer = layer

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
