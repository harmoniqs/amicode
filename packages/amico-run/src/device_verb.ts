// `amico device` — the dispatcher successor (issue #113, slice B3;
// spec-20260708-112732 §3.1 / W-2). The 87-line dispatcher AGENT is retired: its
// job (read device state → recommend the next calibration) is pure lookup with no
// LLM judgment, so it becomes a deterministic CLI verb. Three subcommands, all
// reading the device ops layout under $AMICO_DEVICE_DIR:
//
//   amico device status --device <d> [--now <iso>]
//       → the DeviceStatus projection (per-qubit rollup, measured metrics, ranked
//         node verdicts) + the current allocation lock. Honesty rule: a node with
//         no result is `uncharacterized`, a node past its TTL is `stale` — never a
//         fabricated number.
//
//   amico device next --device <d> [--now <iso>] [--entitled]
//       → the ranked next-actions via the pure evaluate()/nextActions(). qilc
//         (premium) nodes surface the Intonatissimo funnel (never the method
//         acronym) + a standard fallback. A benchmark-locked device reports
//         accepts_submission=false and idle=false (W-2: no concurrent submission).
//
//   amico device lock --device <d> [--mode benchmark] [--owner <id>]
//                     [--acquire | --release | --status] [--force] [--now <iso>]
//       → the benchmark-exclusivity lock (W-2): a device under a benchmark
//         allocation accepts no concurrent submission and the harness suspends
//         leaf fan-out for its duration. Acquire is refused when another owner
//         holds it; re-acquire by the same owner is idempotent.
//
// The evaluate()/nextActions()/lock DECISION logic is pure (device_graph.ts); this
// file is the flag surface + file I/O. FLAG NAMES (S31 guard): the physics-knob
// double-dash flags (gate/pulse/system) are banned in src/; device flags
// (--device/--mode/--owner/--now/--entitled) sidestep them cleanly.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptsSubmission,
  acquireDecision,
  buildDeviceStatus,
  deviceRoot,
  isExclusive,
  loadDevice,
  nextActions,
  releaseDecision,
  type DeviceLock,
} from "./device_graph.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Resolve the evaluation clock: --now <iso> (deterministic, for tests/replay)
 *  else the wall clock. Returns {ms, iso}. */
function resolveNow(argv: string[]): { ms: number; iso: string; error?: string } {
  const raw = flagValue(argv, "--now");
  if (raw === undefined) {
    const d = new Date();
    return { ms: d.getTime(), iso: d.toISOString() };
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { ms: 0, iso: "", error: `--now must be an ISO8601 timestamp (got "${raw}")` };
  return { ms, iso: new Date(ms).toISOString() };
}

function requireDevice(argv: string[], sub: string): { device: string } | VerbResult {
  const device = flagValue(argv, "--device");
  if (!device) return { json: { verb: "device", subcommand: sub, error: "--device <name> is required" }, code: 64 };
  return { device };
}

function lockView(lock: DeviceLock | undefined) {
  return lock
    ? { held: true, mode: lock.mode, owner: lock.owner, acquired_at: lock.acquired_at, exclusive: isExclusive(lock.mode) }
    : { held: false };
}

// ── status ─────────────────────────────────────────────────────────────────
export function deviceStatus(argv: string[]): VerbResult {
  const req = requireDevice(argv, "status");
  if ("json" in req) return req;
  const now = resolveNow(argv);
  if (now.error) return { json: { verb: "device", subcommand: "status", error: now.error }, code: 64 };

  const load = loadDevice(deviceRoot(), req.device);
  if (!load.graph) {
    return {
      json: {
        verb: "device",
        subcommand: "status",
        device: req.device,
        dir: load.dir,
        // honesty: no graph → the whole device is uncharacterized, not fabricated.
        overall: "uncharacterized",
        error: load.graphError,
        lock: lockView(load.lock),
      },
      code: 64,
    };
  }
  const status = buildDeviceStatus(load.graph, load.state, now.ms);
  const overall = status.nodes.reduce<string>(
    (worst, v) => (severity(v.status) > severity(worst) ? v.status : worst),
    "calibrated",
  );
  return {
    json: {
      verb: "device",
      subcommand: "status",
      device: req.device,
      now: now.iso,
      overall,
      qubits: status.qubits,
      metrics: status.metrics,
      calibration_params: status.calibrationParams,
      nodes: status.nodes,
      lock: lockView(load.lock),
      accepts_submission: acceptsSubmission(load.lock),
    },
    code: 0,
  };
}

const SEVERITY_ORDER: Record<string, number> = {
  calibrated: 0,
  uncharacterized: 1,
  stale: 2,
  suspect: 3,
  failed: 4,
};
function severity(s: string): number {
  return SEVERITY_ORDER[s] ?? 0;
}

// ── next ───────────────────────────────────────────────────────────────────
export function deviceNext(argv: string[]): VerbResult {
  const req = requireDevice(argv, "next");
  if ("json" in req) return req;
  const now = resolveNow(argv);
  if (now.error) return { json: { verb: "device", subcommand: "next", error: now.error }, code: 64 };

  const load = loadDevice(deviceRoot(), req.device);
  if (!load.graph) {
    return {
      json: { verb: "device", subcommand: "next", device: req.device, dir: load.dir, error: load.graphError },
      code: 64,
    };
  }
  const entitled = argv.includes("--entitled");
  // A benchmark-locked device is NOT idle (it holds hardware exclusivity) and
  // accepts no concurrent submission — the harness must not fan out onto it.
  const idle = acceptsSubmission(load.lock);
  const result = nextActions(load.graph, load.state, now.ms, { entitled, idle });
  return {
    json: {
      verb: "device",
      subcommand: "next",
      device: req.device,
      now: now.iso,
      entitled,
      idle: result.idle,
      accepts_submission: acceptsSubmission(load.lock),
      lock: lockView(load.lock),
      count: result.ranked_actions.length,
      ranked_actions: result.ranked_actions,
    },
    code: 0,
  };
}

// ── lock ───────────────────────────────────────────────────────────────────
export function deviceLock(argv: string[]): VerbResult {
  const req = requireDevice(argv, "lock");
  if ("json" in req) return req;
  const now = resolveNow(argv);
  if (now.error) return { json: { verb: "device", subcommand: "lock", error: now.error }, code: 64 };

  const root = deviceRoot();
  const load = loadDevice(root, req.device);
  const lockFile = join(load.dir, "lock.json");

  const doAcquire = argv.includes("--acquire");
  const doRelease = argv.includes("--release");
  if (doAcquire && doRelease) {
    return { json: { verb: "device", subcommand: "lock", error: "pass at most one of --acquire / --release" }, code: 64 };
  }

  // default (no --acquire/--release, or --status) → report the current allocation.
  if (!doAcquire && !doRelease) {
    return {
      json: { verb: "device", subcommand: "lock", op: "status", device: req.device, lock: lockView(load.lock), accepts_submission: acceptsSubmission(load.lock) },
      code: 0,
    };
  }

  if (doRelease) {
    const owner = flagValue(argv, "--owner");
    const force = argv.includes("--force");
    const decision = releaseDecision(load.lock, owner, force);
    if (!decision.ok) {
      return { json: { verb: "device", subcommand: "lock", op: "release", released: false, device: req.device, reason: decision.reason, lock: lockView(decision.held) }, code: 64 };
    }
    if (decision.released && existsSync(lockFile)) {
      try {
        rmSync(lockFile, { force: true });
      } catch (e) {
        return { json: { verb: "device", subcommand: "lock", op: "release", error: `failed to remove lock: ${e instanceof Error ? e.message : String(e)}` }, code: 1 };
      }
    }
    return { json: { verb: "device", subcommand: "lock", op: "release", released: decision.released, device: req.device, accepts_submission: true, lock: { held: false } }, code: 0 };
  }

  // --acquire
  const owner = flagValue(argv, "--owner");
  if (!owner) return { json: { verb: "device", subcommand: "lock", op: "acquire", error: "--owner <id> is required to acquire an exclusive allocation" }, code: 64 };
  const mode = flagValue(argv, "--mode") ?? "benchmark";
  const decision = acquireDecision(load.lock, mode, owner, now.iso);
  if (!decision.ok) {
    return { json: { verb: "device", subcommand: "lock", op: "acquire", acquired: false, device: req.device, mode, owner, reason: decision.reason, lock: lockView(decision.held) }, code: 64 };
  }
  try {
    mkdirSync(load.dir, { recursive: true });
    writeFileSync(lockFile, JSON.stringify(decision.lock, null, 2) + "\n");
  } catch (e) {
    return { json: { verb: "device", subcommand: "lock", op: "acquire", error: `failed to write lock: ${e instanceof Error ? e.message : String(e)}` }, code: 1 };
  }
  return {
    json: {
      verb: "device",
      subcommand: "lock",
      op: "acquire",
      acquired: true,
      reentrant: decision.reentrant,
      device: req.device,
      mode,
      owner,
      // W-2: an exclusive allocation refuses concurrent submission + suspends fan-out.
      accepts_submission: acceptsSubmission(decision.lock),
      suspends_fanout: isExclusive(mode),
      lock: lockView(decision.lock),
    },
    code: 0,
  };
}

// ── dispatch ─────────────────────────────────────────────────────────────────
/** The `device` verb body: dispatch on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts) — one impl, two transports. */
export function deviceVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "status") return deviceStatus(rest);
  if (sub === "next") return deviceNext(rest);
  if (sub === "lock") return deviceLock(rest);
  return {
    json: {
      verb: "device",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage:
        "amico device status --device <d>  |  amico device next --device <d> [--entitled]  |  amico device lock --device <d> --owner <id> [--acquire|--release]",
    },
    code: 64,
  };
}
