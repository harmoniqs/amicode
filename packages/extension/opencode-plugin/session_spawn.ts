// ============================================================================
// Pure logic for the `amicode_session` tool — the pack's FIRST server-mutating
// tool (amicode#639). Everything else in this plugin is local bookkeeping;
// this module holds the spawn POLICY so it is readable and unit-testable in
// one place, the same way entities.ts / problems.ts / hashes.ts are. No
// imports: it is loaded inside opencode's embedded Bun runtime by
// amicode_tools.ts, and directly by test/session_spawn.test.ts.
//
// Policy summary:
//   - fan-out per call is capped (SPAWN_MAX_COUNT) — a runaway loop of live
//     sessions burns real model budget;
//   - spawned children stamp metadata {spawned_by, spawned_depth} so the app
//     can auto-open them as background tabs in the parent's pane;
//   - the depth cap (SPAWN_MAX_DEPTH) is SOFT: force=true overrules it. A
//     spawned session spawning its own sessions is allowed but must be a
//     deliberate choice, never an accident.
// ============================================================================

export const SPAWN_MAX_DEPTH = 2;
export const SPAWN_MAX_COUNT = 4;

// The mode-id read-resolve alias table (spec-20260907-011500 D1, #858) —
// autodev → develop, autoresearch → research. NO-IMPORT contract: duplicated
// from @amicode/schema's MODE_ID_ALIASES, parity-pinned by
// test/session_spawn.test.ts. READ-RESOLVE, never migrate-on-write; `build`
// is NOT aliased (it exits the picker, not the vocabulary). The alias
// window's exit rides the next mode-bundle CONTRACT-VERSION bump.
const MODE_ID_ALIASES: Record<string, string> = {
  autodev: "develop",
  autoresearch: "research",
};

/** Resolve an agent id through the read-resolve alias table (identity for
 *  everything the table does not name). */
export function resolveModeIdSpawn(id: string): string {
  return MODE_ID_ALIASES[id] ?? id;
}

export type SpawnMode = "fresh" | "fork";

export type SpawnArgs = {
  prompt: string;
  count: number;
  title: string | null;
  agent: string | null;
  model: { providerID: string; modelID: string } | null;
  command: string | null;
  mode: SpawnMode;
  force: boolean;
  workspace: "create" | string | null;
  // #1345 (ADR-0027 §7 seam 4): the H2 compute-federation "where" dimension.
  // Non-optional in the PARSED type because it always resolves to at least
  // "local". INERT in H1 — threaded + defaulted, never routed on.
  placement: string;
};

export function parseSpawnArgs(a: {
  prompt: string;
  count?: number | null;
  title?: string | null;
  agent?: string | null;
  model?: string | null;
  command?: string | null;
  mode?: string | null;
  force?: boolean | null;
  workspace?: string | null;
  placement?: string | null;
}): { ok: true; args: SpawnArgs } | { ok: false; error: string } {
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "empty prompt" };
  const rawCount = typeof a.count === "number" && Number.isFinite(a.count) ? Math.floor(a.count) : 1;
  const count = Math.min(Math.max(rawCount, 1), SPAWN_MAX_COUNT);
  const mode: SpawnMode = a.mode === "fork" ? "fork" : "fresh";
  let model: SpawnArgs["model"] = null;
  if (typeof a.model === "string" && a.model.trim() !== "") {
    const slash = a.model.indexOf("/");
    if (slash <= 0 || slash === a.model.length - 1) {
      return { ok: false, error: 'model must be "providerID/modelID"' };
    }
    model = { providerID: a.model.slice(0, slash), modelID: a.model.slice(slash + 1) };
  }
  const agent = typeof a.agent === "string" && a.agent.trim() !== "" ? a.agent.trim() : null;
  const title = typeof a.title === "string" && a.title.trim() !== "" ? a.title.trim() : null;
  const command = typeof a.command === "string" && a.command.trim() !== "" ? a.command.trim() : null;
  // workspace (#1060): "create" = new worktree, a non-empty string path = reuse
  // that worktree, null/omitted = no workspace isolation (existing behavior).
  let workspace: SpawnArgs["workspace"] = null;
  if (typeof a.workspace === "string") {
    if (a.workspace === "") return { ok: false, error: "workspace must be \"create\" or a non-empty path, got empty string" };
    workspace = a.workspace;
  }
  // placement (#1345, ADR-0027 §7 seam 4): the optional H2 compute-federation
  // target. absence / null / empty / whitespace-only → "local"; a non-empty
  // string passes through (trimmed). No error branch — a missing "where" is
  // simply "here". INERT in H1: nothing below reads or routes on it.
  const placement =
    typeof a.placement === "string" && a.placement.trim() !== "" ? a.placement.trim() : "local";
  // the read-resolve alias (spec-20260907-011500 D1, #858): an old director
  // id on the amico_session agent param binds the renamed card. READ-RESOLVE,
  // never migrate-on-write; `build` and every non-aliased id pass through.
  return {
    ok: true,
    args: {
      prompt,
      count,
      title,
      agent: agent === null ? null : resolveModeIdSpawn(agent),
      model,
      command,
      mode,
      force: a.force === true,
      workspace,
      placement,
    },
  };
}

// The calling session's own spawned_depth (absent for never-spawned sessions
// = 0). Children get depth + 1; depth >= SPAWN_MAX_DEPTH refuses without
// force.
export function computeDepth(ownMetadata: unknown): number {
  const d = (ownMetadata as { spawned_depth?: unknown } | null | undefined)?.spawned_depth;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0;
}

export function depthRefusal(depth: number): string {
  return (
    `Refused: this session is itself a spawned session (spawned_depth=${depth}) and the ` +
    `default spawn-depth cap is ${SPAWN_MAX_DEPTH}. Pass force=true to overrule it — ` +
    `sessions spawning sessions is allowed but should be a deliberate choice, not an accident.`
  );
}

export function defaultTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat;
}

export function childTitle(base: string, index: number, total: number): string {
  const suffix = total > 1 ? ` (${index + 1}/${total})` : "";
  return `${base}${suffix}`;
}

// hey-api clients return {data?, error?} when not throwing; older call shapes
// may return the payload directly. One defensive unwrap at the boundary.
export function unwrap<T>(res: unknown): T | undefined {
  if (res && typeof res === "object" && "data" in (res as Record<string, unknown>)) {
    return ((res as { data?: unknown }).data ?? undefined) as T | undefined;
  }
  return (res ?? undefined) as T | undefined;
}

export type SpawnedChild = { id: string; title: string };

// ── the double-create gate (#655) ────────────────────────────────────────────
// amicode_session is the pack's only server-mutating verb, and a single spawn
// dispatch used to run its create loop once per EXECUTE with no idempotency
// gate between the tool-call boundary and session.create/session.fork. A
// re-fired dispatch (an engine tool-call retry racing the slow promptAsync,
// double registration, parallel callers) then created a SECOND identical live
// session — both on the model budget (#655: two parentless sessions ingesting
// the same prompt, seconds apart). The gate is IN-FLIGHT ONLY: concurrent
// dispatches of the SAME spawn signature coalesce onto the first run; once it
// settles the entry is gone, so a deliberate sequential re-spawn of the same
// prompt still creates. It changes no stamps, no caps, no count semantics.

export type SpawnGate = {
  coalesce<T>(key: string, run: () => Promise<T>): Promise<T>;
};

/** Counter for workspace: "create" gate keys — each "create" dispatch gets a
 *  unique key so concurrent worktree creations are NEVER coalesced (each needs
 *  its own worktree). Explicit-path dispatches use the path as key component
 *  and coalesce normally. */
let _createCounter = 0;

/** Stable key for one spawn dispatch: the calling session's identity plus the
 * FULLY-PARSED signature (parseSpawnArgs-normalized — a re-serialized retry
 * that says count:1 where the first said count:null lands on the same key).
 * Anything that changes what the dispatch does (mode, force, model, prompt,
 * count, title, agent, caller, workspace) changes the key.
 *
 * Special: workspace: "create" includes a monotonic counter so two concurrent
 * "create" dispatches are NEVER coalesced — each needs its own worktree.
 * Explicit-path dispatches coalesce normally (same path = same key).
 *
 * #1345 (ADR-0027 §7 seam 4): args.placement is DELIBERATELY absent from the
 * key in H1. Placement is inert (nothing routes on it), so two spawns that
 * differ ONLY in placement do the same thing — coalescing them is correct, and
 * excluding it keeps a default (placement:"local") key byte-identical to the
 * pre-slice key. WHEN placement goes live (H2 executor reads it), it MUST enter
 * the key so spawns to DIFFERENT targets no longer wrongly coalesce. */
export function spawnGateKey(sessionID: string, directory: string, args: SpawnArgs): string {
  // workspace: "create" gets a unique suffix so it never coalesces
  const wsKey = args.workspace === "create" ? `create:${++_createCounter}` : (args.workspace ?? null);
  // #1345 H2 seam: args.placement is NOT keyed here (see docstring) — add it
  // to this array only when placement becomes live in H2.
  return JSON.stringify([
    sessionID,
    directory,
    args.prompt,
    args.count,
    args.title,
    args.agent,
    args.model ? `${args.model.providerID}/${args.model.modelID}` : null,
    args.command,
    args.mode,
    args.force,
    wsKey,
  ]);
}

export function createSpawnGate(): SpawnGate {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    async coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) return existing as Promise<T>;
      // Promise.resolve().then(run) tolerates a synchronous throw in run();
      // the finally clears the entry either way — a rejected run never wedges
      // the key, so a later dispatch retries instead of coalescing onto a corpse.
      const p = Promise.resolve()
        .then(run)
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, p);
      return p;
    },
  };
}

/** The transport-wide singleton. The plugin twin and the core run in separate
 * module registries in production, so each transport gates its own
 * dispatches; within one registry this is the one gate every execute shares. */
export const spawnGate = createSpawnGate();

export function summarizeSpawned(children: SpawnedChild[], mode: SpawnMode): string {
  if (children.length === 0) return "No sessions were spawned.";
  const lines = children.map((c) => `- ${c.id}${c.title ? ` — ${c.title}` : ""}`);
  const kind = mode === "fork" ? "sessions forked from this session's history" : "fresh sessions";
  return (
    `Spawned ${children.length} ${kind}. Each is already running its first turn and will ` +
    `appear as a background tab beside this session (no focus change). Ids for follow-up:\n` +
    lines.join("\n")
  );
}
