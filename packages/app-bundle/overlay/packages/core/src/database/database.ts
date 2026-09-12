export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "fs"
import { DatabaseMigration } from "./migration"
import { makeGlobalNode } from "../effect/app-node"
import { Database as BunDatabase } from "bun:sqlite"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/**
 * All tables to merge via INSERT OR IGNORE. Order matters: parents before
 * children to satisfy foreign key relationships on re-enable.
 */
const MERGE_TABLES = [
  "migration",
  "data_migration",
  "project",
  "project_directory",
  "workspace",
  "account",
  "account_state",
  "control_account",
  "credential",
  "event_sequence",
  "event",
  "permission",
  "session",
  "session_message",
  "session_input",
  "session_context_epoch",
  "session_share",
  "message",
  "part",
  "todo",
]

/**
 * One-time consolidation of legacy channel-named DBs into the unified
 * `opencode.db`. Runs synchronously at startup before the Effect DB layer
 * initializes.
 *
 * Strategy:
 *  1. Find all `opencode-*.db` files (skip already-merged `*.db.merged`).
 *  2. If `opencode.db` doesn't exist, rename the largest source to become it
 *     (avoids a full copy of the biggest file).
 *  3. For each remaining source: checkpoint WAL, ATTACH to target, INSERT OR
 *     IGNORE per table, DETACH, rename source to `*.db.merged`.
 *  4. Clean up WAL/SHM sidecars of merged sources.
 *
 * Idempotent: partially-merged sources remain un-renamed and will be retried
 * on next startup. Already `.db.merged` files are ignored.
 */
function consolidateChannelDbs(targetPath: string) {
  const dir = Global.Path.data

  // Collect candidate channel DBs
  let candidates: { path: string; name: string; size: number }[]
  try {
    candidates = readdirSync(dir)
      .filter((f) => f.startsWith("opencode-") && f.endsWith(".db") && !f.endsWith(".db.merged"))
      .map((f) => {
        const full = join(dir, f)
        try {
          const st = statSync(full)
          return { path: full, name: f, size: st.size }
        } catch {
          return null
        }
      })
      .filter((x): x is { path: string; name: string; size: number } => x !== null)
  } catch {
    return
  }

  if (candidates.length === 0) return

  // Sort largest first — the biggest becomes the base if target doesn't exist
  candidates.sort((a, b) => b.size - a.size)

  // If target doesn't exist, promote the largest candidate by rename
  if (!existsSync(targetPath)) {
    const largest = candidates.shift()!
    try {
      renameSync(largest.path, targetPath)
      // Move sidecars too
      for (const ext of ["-wal", "-shm"]) {
        const sidecar = largest.path + ext
        if (existsSync(sidecar)) renameSync(sidecar, targetPath + ext)
      }
    } catch {
      // If rename fails, put it back in the list to be merged normally
      candidates.unshift(largest)
    }
  }

  if (candidates.length === 0) return

  // Open the target DB for merging
  let db: InstanceType<typeof BunDatabase>
  try {
    db = new BunDatabase(targetPath, { create: true, readwrite: true })
  } catch {
    return
  }

  try {
    // Disable foreign keys for the duration of the merge
    db.run("PRAGMA foreign_keys = OFF")
    db.run("PRAGMA journal_mode = WAL")

    for (const candidate of candidates) {
      try {
        // Checkpoint the source WAL so ATTACH sees a clean state
        let sourceDb: InstanceType<typeof BunDatabase> | undefined
        try {
          sourceDb = new BunDatabase(candidate.path, { readwrite: true })
          sourceDb.run("PRAGMA wal_checkpoint(TRUNCATE)")
          sourceDb.close()
          sourceDb = undefined
        } catch {
          sourceDb?.close()
          // If we can't checkpoint, try the merge anyway — ATTACH will read
          // whatever is committed in the main file.
        }

        // Attach source and merge each table
        const alias = "source_db"
        db.run(`ATTACH DATABASE '${candidate.path.replace(/'/g, "''")}' AS ${alias}`)

        try {
          db.run("BEGIN")

          // Get table list from the source to handle schema differences gracefully
          const sourceTables = new Set(
            (
              db.query(`SELECT name FROM ${alias}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
                name: string
              }[]
            ).map((r) => r.name),
          )

          for (const table of MERGE_TABLES) {
            if (!sourceTables.has(table)) continue
            db.run(`INSERT OR IGNORE INTO main."${table}" SELECT * FROM ${alias}."${table}"`)
          }

          db.run("COMMIT")
        } catch {
          try {
            db.run("ROLLBACK")
          } catch {
            // Rollback may fail if transaction wasn't started
          }
          // Leave this source un-renamed for retry on next startup
          try {
            db.run(`DETACH DATABASE ${alias}`)
          } catch {
            // If detach fails too, bail on this source
          }
          continue
        }

        db.run(`DETACH DATABASE ${alias}`)

        // Successfully merged — rename source to *.db.merged
        try {
          renameSync(candidate.path, candidate.path + ".merged")
          // Clean up WAL/SHM sidecars
          for (const ext of ["-wal", "-shm"]) {
            const sidecar = candidate.path + ext
            if (existsSync(sidecar)) unlinkSync(sidecar)
          }
        } catch {
          // Non-fatal: the source stays as-is and will be skipped next time
          // (it's already fully merged, so INSERT OR IGNORE is a no-op)
        }
      } catch {
        // Non-fatal per source: skip this one and try the rest
        continue
      }
    }

    // Re-enable foreign keys
    db.run("PRAGMA foreign_keys = ON")
  } finally {
    db.close()
  }
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  const target = join(Global.Path.data, "opencode.db")
  consolidateChannelDbs(target)
  return target
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
