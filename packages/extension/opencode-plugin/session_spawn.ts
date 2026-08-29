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

export type SpawnMode = "fresh" | "fork";

export type SpawnArgs = {
  prompt: string;
  count: number;
  title: string | null;
  agent: string | null;
  model: { providerID: string; modelID: string } | null;
  mode: SpawnMode;
  force: boolean;
};

export function parseSpawnArgs(a: {
  prompt: string;
  count?: number | null;
  title?: string | null;
  agent?: string | null;
  model?: string | null;
  mode?: string | null;
  force?: boolean | null;
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
  return { ok: true, args: { prompt, count, title, agent, model, mode, force: a.force === true } };
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
