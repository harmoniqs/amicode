// flywheel.ts — SEAM 7 (#709): the flywheel metric's two halves.
//
// (1) The CAMPAIGN-FAMILY KEY as a NAMED MECHANICAL DERIVATION per record kind —
//     never a pre-existing tag, never new stamping (the spec's own words):
//       (a) run dirs       → family from (platform, kind, target) read from the
//           run dir's own records (problem.toml, falling back to solvespec.json);
//       (b) task records   → family from the manifest's `kind` axis (bringup
//           kinds → bring-up; experiments → the closed-loop tune-up family,
//           whose sim rehearsal this build delivers per the spec's journey §5);
//       (c) store entries → family from the SOURCE STAMP (the lineage fields of
//           the pulse bank's metadata.toml: calibration_ref → drift-response,
//           warm_start → tune-up, neither → first-pulse).
// (2) The DECAY COMPUTATION: per family, the trend of (acquisitions,
//     solve-iterations, wall-clock) across same-family campaigns — the metrics
//     the records carry, each metric stated per record kind (absent ≠ 0). The
//     FIRST campaign of a family is the baseline: it has no decay (stated, not
//     zero-division faked).
//
// The device key scopes to the device-touching families (bring-up, tune-up,
// drift response); sim families key on workspace + platform. A sim-only family
// with no device field must COMPUTE, never vacuously fail.
//
// F4 is load-bearing: any field a derivation needs that a real record kind
// lacks is a NAMED FINDING (docs/flywheel-decay.md, grep-pinned by
// test/flywheel.test.ts) — the metric degrades honestly (dropped or
// source-labeled), never silently. Existing records only: this module reads,
// it never stamps.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The repertoire's eight campaign families (spec-20260831 §"the campaign
 *  repertoire"). The derivation maps record kinds onto these; team-ops and
 *  night-runs have NO derivable record-kind evidence in existing records
 *  (finding F-709-6) and never appear as a derived family. */
export type FamilyId =
  | "first-pulse"
  | "regime-sweep"
  | "robustness"
  | "bring-up"
  | "tune-up"
  | "drift-response"
  | "team-ops"
  | "night-runs";

/** The spec's scoping: the device key scopes the device-touching families. */
export const DEVICE_TOUCHING: readonly FamilyId[] = ["bring-up", "tune-up", "drift-response"];
/** Sim families key on workspace + platform. */
export const SIM_FAMILIES: readonly FamilyId[] = ["first-pulse", "regime-sweep", "robustness"];

/** The named findings (F4) — grep-pinned in docs/flywheel-decay.md. */
export const FLYWHEEL_FINDINGS: readonly string[] = [
  "F-709-1 wall-clock: the run-dir contract carries NO end-time field (FINISHED is status+exit_code only; result.toml wall_seconds is optional — 2/358 on the real backlog) — the wall-clock metric degrades to FINISHED mtime − run.toml created_at, source-labeled per campaign and fragile under copy/rsync; honest stamping is the follow-up",
  "F-709-2 device key: the pulse bank's metadata.toml carries NO device field — the device key for device-touching store-derived families (tune-up, drift-response) degrades to the store root + platform; stamping `device` into metadata.toml is the follow-up",
  "F-709-3 acquisitions: run dirs carry no acquisition counts (a sim solve acquires nothing on record) — the acquisitions metric is stated-absent for run-dir campaigns; it is a task-record metric",
  "F-709-4 iterations: task records carry solve-iterations only in prose (result.toml `summary`) — the iterations metric is stated-absent for task-record campaigns",
  "F-709-5 pre-v4 run dirs: a run dir whose script_path is an authored .jl carries no (system, goal) spec — problem.toml/solvespec.json are the v4 problem_spec run shape only — the family is underivable and the record is listed unattributed, never forced",
  "F-709-6 team-ops / night-runs: no field of any of the three record kinds carries session-orchestration facts — the two families are NOT derivable from existing records; they stay unstated until honest stamping exists",
];

function readTomlSafe(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** [system].template → the platform family, mirroring local_executor.ts's
 *  platformFromTemplate (kept deliberately in sync — same source field, same
 *  rule; reimplemented here so the flywheel core stays free of the executor). */
export function platformFromTemplate(template: string): string {
  const base = template.endsWith("System") ? template.slice(0, -"System".length) : template;
  return base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** UTC day (YYYY-MM-DD) of an ISO timestamp. */
function utcDay(iso: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(iso);
  return m ? m[1] : undefined;
}

// ── derivation (a): run dir → family ────────────────────────────────────────

export interface RunDirMetrics {
  /** result.toml `iterations` (the record carries it on the real backlog:
   *  358/358). */
  iterations?: number;
  /** wall clock in seconds: result.toml `wall_seconds` when the record carries
   *  it, else FINISHED mtime − run.toml created_at (finding F-709-1). */
  wall_s?: number;
  wall_source: "record" | "finished-mtime" | "unavailable";
}

export interface RunDirAttribution {
  kind: "run-dir";
  dir: string;
  run_id: string;
  family: FamilyId;
  platform: string;
  goal_kind: string;
  target: string;
  workspace: string;
  day: string;
  metrics: RunDirMetrics;
  /** the exact fields this attribution read (the doc of record pins them). */
  fields_read: string[];
}

export interface RunDirUnattributable {
  kind: "run-dir-unattributable";
  dir: string;
  run_id: string;
  reason: string;
}

export type RunDirFamilyResult = RunDirAttribution | RunDirUnattributable | undefined;

/**
 * The run-dir → family derivation. Fields (the exact set, per
 * docs/flywheel-decay.md):
 *   - problem.toml (falling back to solvespec.json — the v4 problem_spec run
 *     shape carries one or the other in-dir): [system].template (→ platform
 *     family), [goal].kind + [goal].gate | [goal].target (→ target),
 *     [problem].free_dt (min-time marker), [problem].objectives[].kind +
 *     top-level wrappers[].kind (robustness markers);
 *   - run.toml: lab_id (→ workspace), created_at (→ campaign day);
 *   - result.toml: iterations, wall_seconds;
 *   - FINISHED: mtime (wall-clock fallback source only — F-709-1).
 *
 * Mapping onto the repertoire's eight families (stated, never forced):
 *   - free_dt present and ≠ false  → regime-sweep (Piccolo's min-time marker:
 *     the min-time recipe desugars to free_dt → Δt_bounds);
 *   - objectives kind "sensitivity" or a sampling wrapper → robustness;
 *   - otherwise (goal.kind unitary | ket — a one-shot fixed-time synthesis,
 *     gate OR state) → first-pulse (the day-one family; state-prep is NOT
 *     forced into regime-sweep/robustness);
 *   - bring-up/tune-up/drift-response/team-ops/night-runs are NOT derivable
 *     from run-dir fields (stated; they come from task records, store
 *     provenance, or nothing).
 */
export function deriveRunDirFamily(runDir: string): RunDirFamilyResult {
  const manifest = readTomlSafe(join(runDir, "run.toml"));
  if (!manifest) return undefined; // not a run dir (no run.toml) — the caller skips it
  const runId = str(manifest.run_id) ?? "";
  const workspace = str(manifest.lab_id) ?? "default";
  const day = utcDay(str(manifest.created_at) ?? "");

  // the spec: problem.toml first (the inline problem_spec rendering), then
  // solvespec.json (the launch spec) — both are the v4 problem_spec shape.
  let spec: Record<string, unknown> | undefined = readTomlSafe(join(runDir, "problem.toml"));
  let spec_source = "problem.toml";
  if (!spec) {
    const sp = join(runDir, "solvespec.json");
    if (existsSync(sp)) {
      try {
        spec = JSON.parse(readFileSync(sp, "utf8")) as Record<string, unknown>;
        spec_source = "solvespec.json";
      } catch {
        spec = undefined;
      }
    }
  }
  if (!spec) {
    // F-709-5: pre-v4 run dirs (authored .jl script_path) carry no spec in-dir.
    return {
      kind: "run-dir-unattributable",
      dir: runDir,
      run_id: runId,
      reason: `no problem.toml/solvespec.json in-dir (pre-v4 authored-script run dir? script_path=${str(manifest.script_path) ?? "?"}) — F-709-5`,
    };
  }

  const system = isRecord(spec.system) ? spec.system : {};
  const goal = isRecord(spec.goal) ? spec.goal : {};
  const problem = isRecord(spec.problem) ? spec.problem : {};
  const template = str(system.template);
  const goalKind = str(goal.kind);
  const target = str(goal.gate) ?? str(goal.target) ?? "";
  if (!template || !goalKind) {
    return {
      kind: "run-dir-unattributable",
      dir: runDir,
      run_id: runId,
      reason: `spec present but underivable (system.template=${template ?? "?"}, goal.kind=${goalKind ?? "?"})`,
    };
  }

  // ── the family mapping (stated; see the doc of record) ──
  let family: FamilyId;
  const freeDtRaw = problem.free_dt;
  const objectivesRaw = problem.objectives;
  const objectives = Array.isArray(objectivesRaw)
    ? objectivesRaw.filter(isRecord).map((o) => str(o.kind)).filter((k): k is string => k !== undefined)
    : [];
  const wrappersRaw = spec.wrappers;
  const wrappers = Array.isArray(wrappersRaw)
    ? wrappersRaw.filter(isRecord).map((o) => str(o.kind)).filter((k): k is string => k !== undefined)
    : [];
  if (freeDtRaw !== undefined && freeDtRaw !== false) {
    family = "regime-sweep"; // min-time: free_dt = [lo, hi] is the marker
  } else if (objectives.includes("sensitivity") || wrappers.includes("sampling")) {
    family = "robustness"; // adjoint sensitivity / ensemble sampling terms
  } else {
    family = "first-pulse"; // one-shot fixed-time synthesis (unitary | ket)
  }

  // ── the metrics the run-dir records carry ──
  const result = readTomlSafe(join(runDir, "result.toml"));
  const iterations = result ? num(result.iterations) : undefined;
  let wall_s: number | undefined;
  let wall_source: RunDirMetrics["wall_source"] = "unavailable";
  const wallRecorded = result ? num(result.wall_seconds) : undefined;
  if (wallRecorded !== undefined) {
    wall_s = wallRecorded;
    wall_source = "record";
  } else {
    const finished = join(runDir, "FINISHED");
    const created = str(manifest.created_at);
    if (existsSync(finished) && created) {
      const createdMs = Date.parse(created);
      const mtimeMs = statSync(finished).mtimeMs;
      if (Number.isFinite(createdMs) && mtimeMs >= createdMs) {
        wall_s = (mtimeMs - createdMs) / 1000;
        wall_source = "finished-mtime"; // F-709-1: the fs fallback, per-value labeled
      }
    }
  }

  const fields_read = [
    `${spec_source}: [system].template, [goal].kind, [goal].gate|[goal].target, [problem].free_dt, [problem].objectives[].kind, wrappers[].kind`,
    "run.toml: lab_id, created_at",
    "result.toml: iterations, wall_seconds",
    "FINISHED: mtime (fallback source only)",
  ];

  return {
    kind: "run-dir",
    dir: runDir,
    run_id: runId,
    family,
    platform: platformFromTemplate(template),
    goal_kind: goalKind,
    target,
    workspace,
    day: day ?? "",
    metrics: { iterations, wall_s, wall_source },
    fields_read,
  };
}

// ── derivation (b): task record → family ───────────────────────────────────

export interface TaskRecordMetrics {
  /** acquisitions = the count of progress.jsonl events with
   *  ev="progress" AND label="acquire" (the acquisition-count source). */
  acquisitions?: number;
  /** F-709-4: solve-iterations are prose-only on task records
   *  (result.toml `summary`) — stated-absent, never a faked number. */
  iterations?: undefined;
  /** wall clock: result.toml `ended` − task.toml `created` (both
   *  record-carried ISO timestamps — the honest source exists here). */
  wall_s?: number;
  wall_source: "record" | "unavailable";
}

export interface TaskRecordAttribution {
  kind: "task-record";
  dir: string;
  id: string;
  family: FamilyId;
  device: string;
  day: string;
  metrics: TaskRecordMetrics;
  fields_read: string[];
}

export interface TaskRecordUnattributable {
  kind: "task-record-unattributable";
  dir: string;
  id: string;
  reason: string;
}

export type TaskRecordFamilyResult = TaskRecordAttribution | TaskRecordUnattributable | undefined;

/**
 * The task-record → family derivation (strumento TaskRecord shape:
 * task.toml + progress.jsonl + result.toml — the SEAM 4 bridge doctrine's
 * canonical shape). Fields (the exact set, per docs/flywheel-decay.md):
 *   - task.toml: kind (the manifest's kind axis — REQUIRED by the bridge
 *     contract), device (→ the device key), created (→ campaign day);
 *   - result.toml: ended (→ wall clock, with task.toml created);
 *   - progress.jsonl: ev="progress" + label="acquire" (→ acquisitions).
 *
 * Mapping onto the repertoire (stated):
 *   - kind matching /bring-?up/ → bring-up (the BringupPlan graph tasks);
 *   - kind "experiment" → tune-up — the closed-loop family (journey §5: board
 *     experiments AND their sim rehearsal, which is all this build claims
 *     pre-P4);
 *   - any other kind value is an unknown axis value — the bridge contract's
 *     forward-compat rule: derive-and-list, never fail, never force.
 */
export function deriveTaskRecordFamily(taskDir: string): TaskRecordFamilyResult {
  const manifest = readTomlSafe(join(taskDir, "task.toml"));
  if (!manifest) return undefined; // not a task record dir — the caller skips it
  const id = str(manifest.id) ?? "";
  const kind = str(manifest.kind);
  if (!kind) {
    return {
      kind: "task-record-unattributable",
      dir: taskDir,
      id,
      reason: "task.toml kind missing — the kind axis is part of the manifest",
    };
  }
  let family: FamilyId | undefined;
  if (/bring-?up/i.test(kind)) family = "bring-up";
  else if (kind === "experiment") family = "tune-up";
  if (!family) {
    return {
      kind: "task-record-unattributable",
      dir: taskDir,
      id,
      reason: `unknown task.toml kind "${kind}" — the kind axis is open (forward compat); listed, never forced`,
    };
  }

  // acquisitions: count the acquire-labeled progress events.
  let acquisitions = 0;
  let sawProgressEvents = false;
  const progressPath = join(taskDir, "progress.jsonl");
  if (existsSync(progressPath)) {
    for (const line of readFileSync(progressPath, "utf8").split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      let ev: unknown;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue; // a live reader skips a torn line; so does the derivation
      }
      if (isRecord(ev) && ev.ev === "progress") {
        sawProgressEvents = true;
        if (str(ev.label) === "acquire") acquisitions += 1;
      }
    }
  }

  // wall clock: ended − created (both carried).
  const created = str(manifest.created);
  const ended = readTomlSafe(join(taskDir, "result.toml"))?.ended;
  let wall_s: number | undefined;
  let wall_source: TaskRecordMetrics["wall_source"] = "unavailable";
  if (created && str(ended)) {
    const a = Date.parse(created);
    const b = Date.parse(str(ended)!);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
      wall_s = (b - a) / 1000;
      wall_source = "record";
    }
  }

  return {
    kind: "task-record",
    dir: taskDir,
    id,
    family,
    device: str(manifest.device) ?? "",
    day: utcDay(created ?? "") ?? "",
    metrics: {
      acquisitions: sawProgressEvents || existsSync(progressPath) ? acquisitions : undefined,
      wall_s,
      wall_source,
    },
    fields_read: [
      "task.toml: kind, device, created",
      "result.toml: ended",
      'progress.jsonl: ev="progress" + label="acquire"',
    ],
  };
}
