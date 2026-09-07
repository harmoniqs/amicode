// model_routing.ts (service) — S3 (spec-20260907-011500 D3, amicode#860):
// the routing settings surface's route family. THE SETTINGS + DISPATCH
// SURFACES RENDER IN-LINE (the observability clause): the settings section
// is explicitly user-invoked — full visibility there; the dispatch summary
// carries the named outcomes.
//
//   GET  /amicode/model-routing          → per-role rows + provenance + the
//                                          display-only suggestions + the
//                                          drift seat + the seat flags
//   POST /amicode/model-routing          → {role, model} — the user-set write
//   POST /amicode/model-routing/opt-in   → {opt_in: bool}
//   POST /amicode/model-routing/reset    → {role} — clear the user-set row
//
// Same service discipline as the posture family: pure body-builders with
// injectable roots for tests, one success shape per route family,
// ok:false + "code: detail" on failure, FIXED error strings (nothing the
// caller sent is echoed), tolerant reads that fail safe.
//
// The GET is also the REFRESH loop for the live-provider credential
// snapshot: it queries the running engine (the deps' getProviders) and
// rewrites the snapshot file the dispatch seam re-checks per dispatch —
// resolution timing per the spec (bind + re-check, never a stale boot
// snapshot). A failed refresh falls back to the stored snapshot; NEITHER
// present → providers null (unknown), and the suggestions render as null —
// unknown is never rendered as "all live".
import {
  listSubagentRoles,
  suggestedClassesForRole,
  handSetCardModel,
  readRoutingPrefs,
  writeUserSetRole,
  clearUserSetRole,
  setSuggestedOptIn,
  readLiveProviders,
  writeProviderSnapshot,
  readTunedTable,
  readFleetLock,
  resolveRoleRoute,
  driftOf,
  routingPrefsFile,
  routingSnapshotFile,
  type RoutingPrefs,
  type ModelClass,
} from "../../opencode-plugin/model_routing";
import { readFileSync, existsSync } from "node:fs";

export interface ModelRoutingDeps {
  /** The shipped role cards (the suggestion source + the hand-set tier). */
  agentsDir?: string | null;
  prefsFile?: string;
  snapshotFile?: string;
  tunedFile?: string;
  fleetFile?: string;
  /** The running engine's live provider ids (key-free). undefined/throwing
   *  = unknown. */
  getProviders?: () => Promise<string[] | undefined> | string[] | undefined;
  /** The settings surface is PRODUCT-initiated — the fleet lock never
   *  applies here (the provenance class exists; the surface shows its seat
   *  flag only). */
  fleetSession?: boolean;
}

const synthesize = (code: string, detail: string): string => JSON.stringify({ ok: false, error: `${code}: ${detail}` });

const MODEL_RE = /^[^/]+\/[^/]+$/;

interface SnapshotMeta {
  refreshed_at?: string;
}

function snapshotMeta(file: string | undefined): string | null {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SnapshotMeta;
    return typeof parsed.refreshed_at === "string" ? parsed.refreshed_at : null;
  } catch {
    return null;
  }
}

/** Resolve one role for the SURFACE: the effective resolution (as
 *  configured) plus the display-only suggestion (first live candidate of
 *  the card's class prefer-list — rendered even when opt-in is off; that is
 *  the thing the user might opt into). */
function roleView(
  role: string,
  agentsDir: string | null | undefined,
  prefs: RoutingPrefs,
  tuned: Record<string, string> | undefined,
  fleet: Record<string, string> | undefined,
  providers: string[] | undefined,
  fleetSession: boolean,
) {
  const classes = agentsDir ? suggestedClassesForRole(agentsDir, role) : ([] as ModelClass[]);
  const handSet = agentsDir ? handSetCardModel(agentsDir, role) : null;
  const effective = resolveRoleRoute({
    role,
    prefs,
    handSetModel: handSet,
    classes,
    tuned: tuned ?? null,
    fleetLocked: fleet ?? null,
    fleetSession,
    liveProviders: providers ?? undefined,
  });
  // The display-only suggestion: resolve with opt-in FORCED ON (display
  // mode) and take the first AVAILABLE suggested row. No credentials
  // known → null (unknown is not "all live").
  const display = resolveRoleRoute({
    role,
    prefs: { ...prefs, suggested_opt_in: true, roles: {} },
    classes,
    liveProviders: providers ?? undefined,
  });
  const firstSuggested = display.chain.find((row) => row.tier === "suggested" && row.state === "accepted");
  const suggestion =
    firstSuggested !== undefined
      ? {
          model: firstSuggested.model,
          cls: (display.chain.find((row) => row.model === firstSuggested.model && row.tier === "suggested")?.reason.match(
            /suggested: ([a-z-]+) class/,
          )?.[1] ?? null),
        }
      : null;
  return {
    role,
    classes,
    hand_set_model: handSet,
    effective: {
      outcome: effective.outcome,
      model: effective.model,
      tier: effective.tier,
      reason: effective.reason,
      announcement: effective.announcement,
    },
    suggestion,
    chain: effective.chain,
    drift: driftOf(role, prefs, tuned),
  };
}

/** GET /amicode/model-routing. NEVER throws — every failure synthesizes
 *  into the shape. */
export async function modelRoutingResponse(deps: ModelRoutingDeps = {}): Promise<string> {
  const prefs = readRoutingPrefs(prefsFileOf(deps));
  const tuned = deps.tunedFile !== undefined ? readTunedTable(deps.tunedFile) : readTunedTable();
  const fleet = deps.fleetFile !== undefined ? readFleetLock(deps.fleetFile) : readFleetLock();

  // The refresh loop: query the engine, rewrite the snapshot the dispatch
  // seam re-checks. Failed refresh → the stored snapshot stands (its
  // refreshed_at shows the age); neither → null (unknown).
  let providers: string[] | undefined;
  if (deps.getProviders) {
    try {
      const live = await deps.getProviders();
      if (Array.isArray(live)) {
        providers = live;
        writeProviderSnapshot(snapshotFileOf(deps), live);
      }
    } catch {
      /* the engine is unreachable — the snapshot stands or stays unknown */
    }
  }
  if (providers === undefined) providers = readLiveProviders(snapshotFileOf(deps));

  const roles = (deps.agentsDir ? listSubagentRoles(deps.agentsDir) : []).map((role) =>
    roleView(role, deps.agentsDir, prefs, tuned, fleet, providers, deps.fleetSession === true),
  );

  return JSON.stringify({
    ok: true,
    roles,
    opt_in: prefs.suggested_opt_in,
    providers: providers ?? null,
    snapshot_refreshed_at: snapshotMeta(snapshotFileOf(deps)),
    seats: { tuned: tuned !== undefined, fleet: fleet !== undefined },
  });
}

// The default-path shims: the deps keep the route family injectable; the
// production registration passes no files (the ops-dir convention resolves
// inside the resolver module), so the undefined case reads the defaults —
// mirroring posture.ts's prefsFile handling.
const prefsFileOf = (deps: ModelRoutingDeps): string => deps.prefsFile ?? routingPrefsFile();
const snapshotFileOf = (deps: ModelRoutingDeps): string => deps.snapshotFile ?? routingSnapshotFile();

/** POST /amicode/model-routing — {role, model}. The ONLY writes the
 *  settings surface makes into the user-set tier; anything else is the
 *  fixed bad_request (never echoed). */
export async function saveModelRoutingResponse(body: unknown, deps: ModelRoutingDeps = {}): Promise<string> {
  let parsed: { role?: unknown; model?: unknown } | undefined;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as { role?: unknown; model?: unknown };
    } catch {
      parsed = undefined;
    }
  } else if (typeof body === "object" && body !== null) {
    parsed = body as { role?: unknown; model?: unknown };
  }
  const role = typeof parsed?.role === "string" ? parsed.role.trim() : "";
  const model = typeof parsed?.model === "string" ? parsed.model.trim() : "";
  if (role === "" || !MODEL_RE.test(model)) return synthesize("bad_request", 'body must be JSON {role, model: "provider/model"}');
  const agentsDir = deps.agentsDir;
  const known = agentsDir ? listSubagentRoles(agentsDir) : [];
  if (agentsDir !== undefined && !known.includes(role))
    return synthesize("bad_request", "unknown role (the subagent role cards are the vocabulary)");
  const file = prefsFileOf(deps);
  writeUserSetRole(file, role, model);
  return JSON.stringify({ ok: true, role, model, error: null });
}

/** POST /amicode/model-routing/opt-in — {opt_in: bool}. The zero-config
 *  fold's flag: suggestions are display-only until this flips. */
export async function saveRoutingOptInResponse(body: unknown, deps: ModelRoutingDeps = {}): Promise<string> {
  let parsed: { opt_in?: unknown } | undefined;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as { opt_in?: unknown };
    } catch {
      parsed = undefined;
    }
  } else if (typeof body === "object" && body !== null) {
    parsed = body as { opt_in?: unknown };
  }
  if (typeof parsed?.opt_in !== "boolean") return synthesize("bad_request", "body must be JSON {opt_in: boolean}");
  const file = prefsFileOf(deps);
  setSuggestedOptIn(file, parsed.opt_in);
  return JSON.stringify({ ok: true, opt_in: parsed.opt_in, error: null });
}

/** POST /amicode/model-routing/reset — {role}. Clears the role's user-set
 *  row: with the tuned table present the row falls back to the tuned
 *  default (the reset-to-tuned affordance's write); with the seat absent
 *  (today) it falls down the chain. Absent row is a no-op success. */
export async function resetModelRoutingResponse(body: unknown, deps: ModelRoutingDeps = {}): Promise<string> {
  let parsed: { role?: unknown } | undefined;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as { role?: unknown };
    } catch {
      parsed = undefined;
    }
  } else if (typeof body === "object" && body !== null) {
    parsed = body as { role?: unknown };
  }
  const role = typeof parsed?.role === "string" ? parsed.role.trim() : "";
  if (role === "") return synthesize("bad_request", "body must be JSON {role}");
  const file = prefsFileOf(deps);
  clearUserSetRole(file, role);
  return JSON.stringify({ ok: true, role, error: null });
}
