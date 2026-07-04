import type { RunStatus } from "./types";

// ============================================================================
// Pure multi-run registry (1.2, #57) — vscode-free so the state machine is
// unit-testable. The append-only `runs/index` (written by amico-run's
// appendIndex: `runId\tcreatedAt\tscriptPath\n`) is the multi-run source of
// truth; RunsManager tails it and registers every run here. The `latest`
// symlink keeps being WRITTEN by amico-run (frozen contract) but is no longer
// followed for discovery.
// ============================================================================

export interface IndexEntry {
  runId: string;
  createdAt: string;
  scriptPath: string;
}

/** Parse one `runs/index` line (TSV: runId, createdAt, scriptPath). The writer
 *  sanitizes tabs/newlines out of the path, but tolerate extra tabs anyway by
 *  re-joining the tail. Malformed/blank lines → undefined (never throw — the
 *  index is append-only and a torn final line heals on the next tail drain). */
export function parseIndexLine(line: string): IndexEntry | undefined {
  if (!line || !line.trim()) return undefined;
  const parts = line.split("\t");
  if (parts.length < 3) return undefined;
  const [runId, createdAt, ...rest] = parts;
  if (!runId || !createdAt) return undefined;
  return { runId, createdAt, scriptPath: rest.join("\t") };
}

/** Where a run is in its lifecycle. `live` = discovered without FINISHED (a
 *  pipeline is tailing it); `finished` = FINISHED observed (authoritative,
 *  keyed on the FINISHED file — never on result.toml presence). */
export type RunPhase = "live" | "finished";

export interface RunRecord {
  runId: string;
  runDir: string;
  createdAt?: string;
  scriptPath?: string;
  phase: RunPhase;
  /** Terminal status once phase === "finished". */
  status?: RunStatus;
  fidelity?: number;
  /** High-water AMICODE_ITER seen (drives the status bar). */
  latestIter?: number;
}

/** Multi-run record store. Registration is idempotent by runId (the index
 *  replays from offset 0 on every launch; re-registration is a no-op). */
export class RunRegistry {
  private readonly map = new Map<string, RunRecord>();

  /** True if newly registered; false if the runId was already known. */
  register(rec: RunRecord): boolean {
    if (this.map.has(rec.runId)) return false;
    this.map.set(rec.runId, { ...rec });
    return true;
  }

  /** Fill ONLY missing metadata on an existing record — a scheduler-registered
   *  run (runId+runDir only) gains createdAt/scriptPath when its index line
   *  lands later. Never overwrites present values (first registration wins for
   *  everything stateful). */
  backfill(runId: string, meta: { createdAt?: string; scriptPath?: string }): void {
    const r = this.map.get(runId);
    if (!r) return;
    if (r.createdAt === undefined && meta.createdAt !== undefined) r.createdAt = meta.createdAt;
    if (r.scriptPath === undefined && meta.scriptPath !== undefined) r.scriptPath = meta.scriptPath;
  }

  get(runId: string): RunRecord | undefined {
    return this.map.get(runId);
  }

  /** Snapshot COPIES — callers (1.3 trees) can't mutate registry state. */
  all(): RunRecord[] {
    return [...this.map.values()].map((r) => ({ ...r }));
  }

  noteIter(runId: string, iter: number): void {
    const r = this.map.get(runId);
    if (!r) return;
    if (r.latestIter === undefined || iter > r.latestIter) r.latestIter = iter;
  }

  /** First terminal wins: re-marking an already-finished run is a no-op, so a
   *  stray second call can't leave e.g. status:"failed" beside a stale
   *  fidelity from an earlier "completed" (review #70 — the guard lives HERE,
   *  not only in the manager's completeRun, because this is public surface the
   *  1.3 consumers touch). */
  markFinished(runId: string, status: RunStatus, fidelity?: number): void {
    const r = this.map.get(runId);
    if (!r || r.phase === "finished") return;
    r.phase = "finished";
    r.status = status;
    if (fidelity !== undefined) r.fidelity = fidelity;
  }
}
