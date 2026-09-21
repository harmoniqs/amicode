// fleet_topology.ts — the extension's fleet-topology read (#1106, fleet
// rearchitect P3b-2; spec spec-20260913-114814 countermeasure row 1, §3 D1).
//
// THE ONE READ PATH: this machine's fleet topology is consumed from the
// verb-refreshed projection cache (`~/.amico/ops/fleet/projection.json` —
// the stable convention path, refreshed by `amico fleet status --projection`),
// read through @amicode/schema's fleet_projection reader VERBATIM — contract
// validation, base-default discipline, and D1 epoch-bound freshness all come
// from the reader. This module NEVER parses the machine-local fleet config
// file — amicissimo parses and publishes, amicode consumes (the spec's
// ONE-parser countermeasure; that file stays writable by the mode flows in
// fleet_fallback.ts, which is a writer, never a parser).
//
// Absent / broken projections are RENDERED STATES, not error dumps and never a
// silent fallthrough to raw-file reading: `absent` carries the refresh pointer,
// `broken` carries the reader's own loud rejection verbatim. The refresh goes
// through the VERB (`amico fleet status --projection`) — the CLI is the only
// door; this module never invokes the Python publisher directly. Exit 75 is the
// bootstrap exception: base-standalone STATED with the grant pointer (never a
// mode write, spec invariant 7); a CLI-absent machine gets the IDENTICAL branch;
// a verb failure is a distinct honest state, never mislabeled as bootstrap.
//
// D1 freshness: the carried counter + hub-epoch render verbatim; the verdict
// exists only against a previous projection (freshnessBetween — the schema's
// ONE comparison). "unknown" (cross-epoch or rewind) forces a refetch through
// the verb AND surfaces — never a false-fresh badge, never a wall-clock age
// (this module holds no clock).
import { spawnSync } from "node:child_process";
import {
  FleetContractVersionError,
  freshnessAdvisory,
  freshnessBetween,
  fleetProjectionCachePath,
  readProjection,
  type FleetFreshness,
  type FleetProjection,
} from "@amicode/schema";

/** The documented cache-path fragment — the same string the bash consumers
 *  (guard, installer) compose from `$HOME`. The full default path comes from
 *  `@amicode/schema`'s `fleetProjectionCachePath()` — ONE definition. */
export const FLEET_TOPOLOGY_CACHE_DEFAULT_HINT = ".amico/ops/fleet/projection.json";

/** The refresh verb — the CLI door every consumer uses. */
export const FLEET_TOPOLOGY_REFRESH_COMMAND = "amico fleet status --projection";

/** The fleet-guard binary's filename suffix — the installed never-fork signal
 *  (`~/.local/bin/amico-opencode-fleet-guard`). OS-neutral: the guard is the
 *  same shim on mac, linux, and WSL; a client machine configures it as
 *  `amicode.opencodeBinary` so a spawn attempt fails closed. */
export const FLEET_GUARD_BINARY_SUFFIX = "amico-opencode-fleet-guard";

/** The cross-platform never-fork decision (#1261, AC3): should this machine
 *  DIVERT to the fleet-client relay (and spawn NO local engine) instead of
 *  cold-spawning one? True iff the guard binary is configured AND the
 *  projection reads role=client.
 *
 *  PLATFORM-AGNOSTIC by construction — it consults no `process.platform`. The
 *  bug it replaces: the caller early-returned on `process.platform !== "darwin"`,
 *  so a linux/WSL client silently cold-spawned a local engine (the ADR-0005
 *  split-brain the guard exists to prevent, #1227). The role read is OS-neutral
 *  (the projection), so never-fork holds on every platform. Every non-ok
 *  topology (absent/broken) is NOT a client — the base standalone floor. */
export function divertToFleetRelay(binary: string | undefined, state: FleetTopologyState): boolean {
  if (!binary || !binary.endsWith(FLEET_GUARD_BINARY_SUFFIX)) return false;
  return state.kind === "ok" && state.role === "client";
}

/** A verb run: `code` null = the CLI itself was absent (ENOENT — the
 *  CLI-absent bootstrap branch); 75 = the bootstrap exception; 0 = the cache
 *  was refreshed; anything else = a verb failure (never bootstrap). */
export interface VerbRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface FleetCanonical {
  host?: string;
  port?: number;
  sshAlias?: string;
}

/** The lawful read: topology + mode/posture + provenance + the carried
 *  freshness fields. `role` is the topology section's value VERBATIM (an
 *  out-of-vocabulary value surfaces, never remapped); a projection with no
 *  topology section is the base default (role = standalone) — honestly
 *  carried by the publisher, not invented here. */
export interface FleetTopologyOk {
  kind: "ok";
  role: string;
  canonical?: FleetCanonical;
  previousBinary?: string;
  previousPort?: number;
  mode: string;
  posture: string;
  /** The reader's freshness verdict, ONLY when a previous projection was
   *  supplied (freshnessBetween is the schema's one comparison — null
   *  previous = no verdict, carried fields only). */
  verdict?: FleetFreshness;
  /** The surfaced advisory for the verdict ("" for fresh — no badge noise). */
  advisory?: string;
  freshness: { counter?: unknown; hubEpoch?: unknown };
  /** The section's provenance source — metadata BESIDE the value, rendered. */
  provenanceSource: string;
  /** The raw lawful projection (for freshnessBetween at the next read). */
  projection: FleetProjection;
}

/** The cache artifact is absent — a RENDERED state: standalone-adjacent (the
 *  base default is the reader's discipline) but surfaced with the refresh
 *  pointer so a client machine is never silently mistaken for one. */
export interface FleetTopologyAbsent {
  kind: "absent";
  /** The honest statement + the refresh pointer (the verb, the CLI door). */
  detail: string;
}

/** The cache artifact is present but failed the contract read — the reader's
 *  LOUD rejection carried verbatim (both versions named for a version
 *  mismatch), never an error dump, never a raw-file fallthrough. */
export interface FleetTopologyBroken {
  kind: "broken";
  detail: string;
}

export type FleetTopologyState = FleetTopologyOk | FleetTopologyAbsent | FleetTopologyBroken;

export interface ReadFleetTopologyOpts {
  /** The cache artifact path (default: the stable convention path). */
  cachePath?: string;
  /** The previous lawful projection — supplies the D1 freshness verdict. */
  previous?: FleetProjection | null;
}

export function readFleetTopology(opts: ReadFleetTopologyOpts = {}): FleetTopologyState {
  const cachePath = opts.cachePath ?? fleetProjectionCachePath();
  let proj: FleetProjection;
  try {
    proj = readProjection(cachePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        kind: "absent",
        detail:
          `fleet projection absent at ${cachePath} — refresh it with \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` ` +
          `(the CLI is the only door; the cache convention is <home>/${FLEET_TOPOLOGY_CACHE_DEFAULT_HINT}; ` +
          `the base default is standalone, stated here — never a silent raw-file read)`,
      };
    }
    const detail =
      e instanceof FleetContractVersionError
        ? `${e.message} (the cached projection at ${cachePath} speaks a contract this extension does not — refresh via \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` or re-clone)`
        : `fleet projection at ${cachePath} failed the contract read: ${(e as Error).message} — refresh via \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\``;
    return { kind: "broken", detail };
  }

  const sections = proj.sections ?? {};
  const topologyValue = objectValue(proj, "topology");
  const modeSection = sections.mode;
  const postureSection = sections.posture;
  const mode = modeSection?.value === undefined ? "standalone" : String(modeSection.value);
  const posture = postureSection?.value === undefined ? "ok" : String(postureSection.value);

  const verdict = opts.previous === undefined || opts.previous === null ? undefined : freshnessBetween(opts.previous, proj);
  const advisory = verdict === undefined ? undefined : freshnessAdvisory(verdict) || undefined;

  const fresh = (proj.freshness ?? {}) as { counter?: unknown; hub_epoch?: unknown };
  return {
    kind: "ok",
    role: topologyValue === undefined ? "standalone" : String(topologyValue.role ?? "standalone"),
    ...(canonicalOf(topologyValue) === undefined ? {} : { canonical: canonicalOf(topologyValue) }),
    ...(topologyValue?.previousBinary === undefined ? {} : { previousBinary: String(topologyValue.previousBinary) }),
    ...(topologyValue?.previousPort === undefined ? {} : { previousPort: Number(topologyValue.previousPort) }),
    mode,
    posture,
    ...(verdict === undefined ? {} : { verdict, ...(advisory === undefined ? {} : { advisory }) }),
    freshness: { counter: fresh.counter, hubEpoch: fresh.hub_epoch },
    provenanceSource:
      topologyValue === undefined
        ? String(sections.mode?.provenance?.source ?? "unknown")
        : String(sections.topology?.provenance?.source ?? "unknown"),
    projection: proj,
  };
}

/** The refresh decision — the guard-parity read used at the live spawn
 *  decision points: read the cache; when absent or broken (or when D1 says
 *  unknown freshness vs the previous) refresh ONCE through the verb and
 *  re-read. The bootstrap exception (exit 75) and a CLI-absent verb produce
 *  the IDENTICAL stated base-standalone branch; a verb failure is surfaced as
 *  the honest non-bootstrap state it is. */
export interface FleetTopologyDecision {
  state: FleetTopologyState;
  /** The verb refreshed the cache and the re-read succeeded. */
  refreshed: boolean;
  /** Non-null ONLY for the bootstrap exception family (75 / CLI-absent). */
  bootstrap: null | { reason: "verb-75" | "cli-absent"; stated: string };
}

export interface ReadWithRefreshOpts extends ReadFleetTopologyOpts {
  /** The verb seam (injectable; default: spawnSync `amico fleet status
   *  --projection` from PATH with a bounded timeout). */
  runVerb?: () => VerbRunResult;
}

export function readFleetTopologyWithRefresh(opts: ReadWithRefreshOpts = {}): FleetTopologyDecision {
  const first = readFleetTopology(opts);
  const verdictUnknown = first.kind === "ok" && first.verdict === "unknown";
  if (first.kind === "ok" && !verdictUnknown) {
    return { state: first, refreshed: false, bootstrap: null };
  }

  const runVerb = opts.runVerb ?? defaultRunVerb;
  const result = runVerb();

  if (result.code === 75) {
    return {
      state: first,
      refreshed: false,
      bootstrap: {
        reason: "verb-75",
        stated:
          `base-standalone (bootstrap exception — the verb exited 75): this install does not hold the fleet-authority ` +
          `grant, so no projection can be published. The mode field is untouched (spec invariant 7). ` +
          `Base-standalone stated with the pointer: see the verb's rendered output for the grant path.\n${result.stdout.trim()}`,
      },
    };
  }
  if (result.code === null) {
    return {
      state: first,
      refreshed: false,
      bootstrap: {
        reason: "cli-absent",
        stated:
          `base-standalone (bootstrap exception — the \`amico\` CLI is absent, so \`${FLEET_TOPOLOGY_REFRESH_COMMAND}\` ` +
          `cannot run): identical to the exit-75 branch. The mode field is untouched (spec invariant 7).`,
      },
    };
  }
  if (result.code !== 0) {
    const detail =
      first.kind === "broken"
        ? `${first.detail}\n  and the refresh failed too (\`amico fleet status --projection\` exited ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`
        : `fleet topology unavailable: the cache is ${first.kind === "absent" ? "absent" : "unreadable"} and the refresh (\`${FLEET_TOPOLOGY_REFRESH_COMMAND}\`) exited ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`;
    return { state: { kind: "broken", detail }, refreshed: false, bootstrap: null };
  }

  const second = readFleetTopology(opts);
  return { state: second, refreshed: second.kind === "ok", bootstrap: null };
}

/** The default verb seam: the CLI from PATH, bounded. `code` null = ENOENT. */
function defaultRunVerb(): VerbRunResult {
  const r = spawnSync("amico", ["fleet", "status", "--projection"], { encoding: "utf8", timeout: 60_000 });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { code: null, stdout: "", stderr: "ENOENT" };
    return { code: -1, stdout: r.stdout ?? "", stderr: `${code ?? "error"}: ${r.error.message}` };
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A verb runner with extra PATH entries (the extension host's `amico` may
 *  not be on the ambient PATH — the amico-run launcher dir is prepended the
 *  same way the server spawn's PATH is, so an enrolled machine never gets
 *  misrouted to the CLI-absent branch). */
export function verbRunnerWithPaths(extraPaths: string[], timeoutMs = 30_000): () => VerbRunResult {
  return () => {
    const env = { ...process.env };
    const base = env.PATH ?? "";
    env.PATH = [...extraPaths, base].filter((p) => p !== "").join(":");
    const r = spawnSync("amico", ["fleet", "status", "--projection"], { env, encoding: "utf8", timeout: timeoutMs });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { code: null, stdout: "", stderr: "ENOENT" };
      return { code: -1, stdout: r.stdout ?? "", stderr: `${code ?? "error"}: ${r.error.message}` };
    }
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** The ok state as the `FleetConfig` shape the hub flows consume
 *  (hub_ops.resolveHubTarget) — the topology section's value verbatim; every
 *  non-ok state is null (the caller renders, never a silent default). An
 *  out-of-vocabulary role is surfaced elsewhere and returns null here — it is
 *  never silently remapped into the closed role vocabulary. */
export function fleetConfigOf(state: FleetTopologyState): import("./fleet_fallback").FleetConfig | null {
  if (state.kind !== "ok") return null;
  const role = state.role;
  if (role !== "standalone" && role !== "server" && role !== "client") return null;
  return {
    role,
    ...(state.canonical === undefined ? {} : { canonical: state.canonical }),
    ...(state.previousBinary === undefined ? {} : { previousBinary: state.previousBinary }),
    ...(state.previousPort === undefined ? {} : { previousPort: state.previousPort }),
  };
}

// ── internals ─────────────────────────────────────────────────────────────────

function objectValue(proj: FleetProjection, section: string): Record<string, unknown> | undefined {
  const v = proj.sections?.[section]?.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

function canonicalOf(topology: Record<string, unknown> | undefined): FleetCanonical | undefined {
  if (topology === undefined) return undefined;
  const c = topology.canonical;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return undefined;
  const rec = c as Record<string, unknown>;
  const canonical: FleetCanonical = {};
  if (typeof rec.host === "string") canonical.host = rec.host;
  if (typeof rec.port === "number") canonical.port = rec.port;
  if (typeof rec.sshAlias === "string") canonical.sshAlias = rec.sshAlias;
  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

/** Derive the synthetic machine_id for a FleetCanonical — the same derivation
 *  the sidebar uses at `sidebar_view.ts:516` to synthesize the canonical-server
 *  row's `machineId`. Shared so both the sidebar and the attach action use the
 *  same predicate, preventing synthesis drift. (#1411, ADR 0030 §D4) */
export function canonicalMachineId(c: FleetCanonical | undefined): string | null {
  if (!c) return null;
  const id = c.host ?? c.sshAlias;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}
