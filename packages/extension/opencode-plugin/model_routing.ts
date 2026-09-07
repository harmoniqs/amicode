// ============================================================================
// model_routing.ts — S3 subagent model routing (spec-20260907-011500 D3,
// amicode#860). The routing policy resolver: resolves each subagent role's
// effective model through the precedence chain
//
//     user-set > fleet-locked > tuned > suggested > default
//
// with the uniform credential gate, failover-as-chain-walk, full provenance,
// and named announcements. Lives in opencode-plugin/ as a SIBLING so both
// transports share the ONE implementation (the #700 A3 discipline): the core
// tool table (src/amicode_tools_core.ts), the plugin twin, and the service
// route all import it. Harness-neutral: node builtins + explicit paths only.
//
// THE INVARIANTS (the spec's critics' convergent blockers — all binding):
//   - Zero-config: the DEFAULT tier is inherit-session-model — exactly
//     today's dispatch. Suggestions are display-only until the user opts
//     in (suggested_opt_in), so a zero-config user's dispatch is
//     byte-identical to the un-routed spawn path.
//   - Uniform credential gate: suggestions AND the tuned overlay are
//     credential-filtered at resolution time — a model the user holds no
//     credential for never becomes effective policy (drops to the next
//     tier, named reason). Failover walks the candidate chain downward at
//     dispatch time; the resolved model + fallback reason are recorded and
//     surfaced — credential-driven downgrades are ANNOUNCED, never silent.
//   - A hand-set `model:` field on a role card outranks the entire chain
//     (it IS user-set for that card).
//   - Fleet-locked applies ONLY to fleet-spawned sessions/dispatches —
//     never product-initiated work.
//   - The tuned table and the fleet lock are SEATS here: the files resolve
//     (readTunedTable / readFleetLock) but S4 (amicissimo#399) and the
//     Telaio deployment supply content. Absent seat → the tier resolves as
//     absent — never guessed.
//
// Public defaults name model CLASSES (workhorse / strongest-reasoner /
// fast-cheap), never campaign-tuned assignments — the public/premium
// boundary holds by construction. The class → concrete-candidate catalog
// below is the public suggestion vocabulary; the role cards' `Model
// routing` lines name the classes (the suggestion source).
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The provenance classes — every resolution row carries exactly one; no
 *  silent source (the settings surface renders this per row). */
export type RoutingProvenance = "user-set" | "fleet-locked" | "tuned" | "suggested" | "default";

/** The public model classes — the only nouns a public prefer-list may use. */
export const MODEL_CLASSES = ["workhorse", "strongest-reasoner", "fast-cheap"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** The public suggestion catalog: class → ordered concrete candidates.
 *  STATIC and public by design — the tuned lineage never appears here (the
 *  tuned tier rides the S4 seat). The filter against LIVE credentials is
 *  what makes a suggestion honest: a provider the user holds no credential
 *  for never becomes effective policy. (Follow-up: source this from the
 *  engine's models.dev registry instead of a hand list.) */
export const MODEL_CLASS_CATALOG: Record<ModelClass, string[]> = {
  workhorse: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "zai/glm-5.3-flash"],
  "strongest-reasoner": ["anthropic/claude-opus-4-1", "openai/gpt-5", "zai/glm-5.3"],
  "fast-cheap": ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini", "zai/glm-5.3-flash"],
};

// ── the ops-dir files (the #864 convention: $AMICODE_OPS_DIR → ~/.amico) ────

function opsDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICODE_OPS_DIR;
  return v && v.trim() !== "" ? v : path.join(os.homedir(), ".amico", "amicode");
}

/** The user-set tier's prefs file (the settings surface writes here). */
export function routingPrefsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opsDirOf(env), "model-routing.json");
}

/** The live-provider credential snapshot — written by the extension host
 *  (which queries the running engine's /config/providers), read per
 *  dispatch (the re-check). Absent = credentials UNKNOWN (fail safe). */
export function routingSnapshotFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opsDirOf(env), "model-routing-providers.json");
}

/** The tuned table's SEAT (S4 writes the per-release snapshot). */
export function tunedTableFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opsDirOf(env), "model-routing-tuned.json");
}

/** The fleet lock's SEAT (the Telaio deployment writes it). */
export function fleetLockFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opsDirOf(env), "model-routing-fleet.json");
}

// ── the prefs (the user-set tier) ────────────────────────────────────────────

export interface RoutingPrefs {
  schema_version: number;
  /** The zero-config fold: suggestions are display-only until opt-in. */
  suggested_opt_in: boolean;
  /** role → "provider/model" — the user-set rows. */
  roles: Record<string, string>;
}

const ZERO_CONFIG_PREFS: RoutingPrefs = { schema_version: 1, suggested_opt_in: false, roles: {} };

/** Fail-safe read: absent, corrupt, or off-shape → the zero-config default.
 *  A corrupt preference must never widen the policy. */
export function readRoutingPrefs(file: string = routingPrefsFile()): RoutingPrefs {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...ZERO_CONFIG_PREFS };
    const roles: Record<string, string> = {};
    if (typeof parsed.roles === "object" && parsed.roles !== null && !Array.isArray(parsed.roles)) {
      for (const [role, model] of Object.entries(parsed.roles as Record<string, unknown>)) {
        if (typeof model === "string" && /^[^/]+\/[^/]+$/.test(model.trim())) roles[role] = model.trim();
      }
    }
    return {
      schema_version: 1,
      suggested_opt_in: parsed.suggested_opt_in === true,
      roles,
    };
  } catch {
    return { ...ZERO_CONFIG_PREFS };
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writePrefs(file: string, prefs: RoutingPrefs): RoutingPrefs {
  atomicWrite(file, JSON.stringify({ ...prefs, schema_version: 1 }, null, 2) + "\n");
  return readRoutingPrefs(file);
}

/** Write (or overwrite) one role's user-set row; returns the fresh prefs. */
export function writeUserSetRole(file: string, role: string, model: string): RoutingPrefs {
  const prefs = readRoutingPrefs(file);
  return writePrefs(file, { ...prefs, roles: { ...prefs.roles, [role]: model } });
}

/** Remove one role's user-set row (the settings reset affordance); absent
 *  role is a no-op. */
export function clearUserSetRole(file: string, role: string): RoutingPrefs {
  const prefs = readRoutingPrefs(file);
  if (!(role in prefs.roles)) return prefs;
  const roles = { ...prefs.roles };
  delete roles[role];
  return writePrefs(file, { ...prefs, roles });
}

/** The opt-in flag — the ONLY bridge from display-only suggestions to the
 *  effective suggested tier. */
export function setSuggestedOptIn(file: string, on: boolean): RoutingPrefs {
  const prefs = readRoutingPrefs(file);
  return writePrefs(file, { ...prefs, suggested_opt_in: on });
}

// ── the live-provider snapshot (the credential gate's input) ────────────────

/** Write the credential snapshot. `providers` = key-free provider ids the
 *  running engine resolves (the /config/providers strip — ids only, never
 *  keys; the no-leak boundary lives with the caller's fetch). */
export function writeProviderSnapshot(file: string, providers: string[]): void {
  atomicWrite(
    file,
    JSON.stringify({ snapshot_version: 1, refreshed_at: new Date().toISOString(), providers }, null, 2) + "\n",
  );
}

/** The live provider ids, or undefined when the snapshot is absent/corrupt
 *  (UNKNOWN — the resolver fails safe to the default tier, named reason).
 *  undefined is honest: an empty array would claim "no credentials" and
 *  silently strip every tier. */
export function readLiveProviders(file: string = routingSnapshotFile()): string[] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: unknown };
    if (!Array.isArray(parsed.providers)) return undefined;
    const ids = parsed.providers.filter((p): p is string => typeof p === "string" && p.trim() !== "");
    return ids;
  } catch {
    return undefined;
  }
}

/** The tuned table's SEAT: absent/corrupt → undefined (the tier resolves as
 *  absent — S4 supplies content; never guessed here). */
export function readTunedTable(file: string = tunedTableFile()): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [role, model] of Object.entries(parsed)) {
      if (typeof model === "string" && /^[^/]+\/[^/]+$/.test(model.trim())) out[role] = model.trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The fleet lock's SEAT: same contract as the tuned table; consumed ONLY
 *  for fleet-spawned dispatches. */
export function readFleetLock(file: string = fleetLockFile()): Record<string, string> | undefined {
  return readTunedTable(file);
}

// ── the role cards (the suggestion source + the hand-set tier) ──────────────

/** Parse the class prefer-list out of a card's `Model routing, <kind>:`
 *  line. The line names CLASSES in preferential order (prose may follow —
 *  it is read by humans, ignored by the machine). Unknown tokens never
 *  enter the list; duplicates collapse to their first position. */
export function parseModelRoutingLine(cardText: string): ModelClass[] {
  const m = /^Model routing,\s*[A-Za-z][A-Za-z -]*:\s*(.+)$/m.exec(cardText);
  if (!m) return [];
  const body = m[1] ?? "";
  const hits: Array<{ cls: ModelClass; at: number }> = [];
  for (const cls of MODEL_CLASSES) {
    const at = body.indexOf(cls);
    if (at !== -1) hits.push({ cls, at });
  }
  hits.sort((a, b) => a.at - b.at);
  const out: ModelClass[] = [];
  for (const { cls } of hits) if (!out.includes(cls)) out.push(cls);
  return out;
}

/** The subagent roles: the shipped cards whose frontmatter carries
 *  `mode: subagent` (the director mode cards are picker-routed, never
 *  settings-routed). Unreadable dir → empty (the surface renders empty,
 *  never a fabricated list). */
export function listSubagentRoles(agentsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const roles: string[] = [];
  for (const f of entries) {
    try {
      const text = fs.readFileSync(path.join(agentsDir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      if (fm && /^mode:[ \t]*subagent[ \t]*$/m.test(fm[1] ?? "")) {
        roles.push(f.replace(/\.md$/, ""));
      }
    } catch {
      /* unreadable card → skip, never a partial list */
    }
  }
  return roles.sort();
}

/** The card's suggested class prefer-list (the suggestion source). */
export function suggestedClassesForRole(agentsDir: string, role: string): ModelClass[] {
  try {
    return parseModelRoutingLine(fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8"));
  } catch {
    return [];
  }
}

/** The card's hand-set `model:` frontmatter field — the USER-SET tier for
 *  that card, outranking the entire chain. A value without a provider half
 *  is not a routable model → null. */
export function handSetCardModel(agentsDir: string, role: string): string | null {
  try {
    const text = fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const m = fm ? /^model:[ \t]*(.+)$/m.exec(fm[1] ?? "") : null;
    const v = m?.[1]?.trim();
    return v && /^[^/]+\/[^/]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// ── the resolver ─────────────────────────────────────────────────────────────

/** One walk step. Every candidate is RECORDED — accepted or skipped with a
 *  named reason — so the settings surface and the dispatch summary can
 *  surface the whole walk (the observability clause: ambient when ignored,
 *  inspectable on click). */
export interface ChainRow {
  tier: RoutingProvenance;
  model: string;
  state: "accepted" | "skipped";
  reason: string;
}

export interface RoutingResolution {
  role: string;
  /** "model" = a routing candidate was accepted; "inherit" = the session's
   *  model (the default tier — today's dispatch). */
  outcome: "model" | "inherit";
  model: string | null;
  providerID: string | null;
  modelID: string | null;
  tier: RoutingProvenance;
  /** The NAMED reason for the outcome. */
  reason: string;
  /** The full candidate walk, in precedence order, states + reasons recorded. */
  chain: ChainRow[];
  /** The announcement when a credential-driven downgrade occurred — null
   *  when the top candidate accepted or nothing was configured. */
  announcement: string | null;
}

export interface ResolveRouteInputs {
  role: string;
  /** The user-set tier + the opt-in flag. */
  prefs?: RoutingPrefs;
  /** The role card's hand-set `model:` (user-set for that card). */
  handSetModel?: string | null;
  /** The card's suggested class prefer-list. */
  classes?: ModelClass[];
  /** The tuned seat (S4 supplies; absent today). */
  tuned?: Record<string, string> | null;
  /** The fleet-locked seat (the Telaio deployment supplies). */
  fleetLocked?: Record<string, string> | null;
  /** True ONLY for fleet-spawned dispatches — the lock never applies to
   *  product-initiated work. */
  fleetSession?: boolean;
  /** The live provider ids (the credential snapshot). undefined = unknown
   *  → fail safe to the default tier, named reason. */
  liveProviders?: string[] | null;
}

const providerOf = (model: string): string => model.split("/")[0] ?? model;

function buildChain(inputs: ResolveRouteInputs): ChainRow[] {
  const rows: Array<{ tier: RoutingProvenance; model: string; source: string }> = [];
  const userRow = inputs.prefs?.roles?.[inputs.role];
  if (userRow) rows.push({ tier: "user-set", model: userRow, source: "user-set for this role (settings)" });
  if (inputs.handSetModel)
    rows.push({ tier: "user-set", model: inputs.handSetModel, source: "hand-set model on the role card" });
  if (inputs.fleetSession === true && inputs.fleetLocked?.[inputs.role])
    rows.push({ tier: "fleet-locked", model: inputs.fleetLocked[inputs.role] as string, source: "fleet-locked policy (fleet-spawned dispatch)" });
  if (inputs.tuned?.[inputs.role])
    rows.push({ tier: "tuned", model: inputs.tuned[inputs.role] as string, source: "tuned policy snapshot" });
  // The suggested tier: display-only until opt-in (the zero-config fold).
  if (inputs.prefs?.suggested_opt_in === true) {
    for (const cls of inputs.classes ?? []) {
      for (const candidate of MODEL_CLASS_CATALOG[cls] ?? []) {
        rows.push({ tier: "suggested", model: candidate, source: `suggested: ${cls} class (the role card's prefer-list)` });
      }
    }
  }
  return rows.map((r) => ({ tier: r.tier, model: r.model, state: "skipped" as const, reason: r.source }));
}

/** Resolve one role's effective model through the precedence chain. Pure
 *  over its inputs — the dispatch seam and the settings route both call
 *  THIS, so the surface shows exactly what dispatch honors. */
export function resolveRoleRoute(inputs: ResolveRouteInputs): RoutingResolution {
  const role = inputs.role;
  const chain = buildChain(inputs);
  const known = inputs.liveProviders !== undefined && inputs.liveProviders !== null;

  let accepted: ChainRow | undefined;
  for (const row of chain) {
    if (!known) {
      row.state = "skipped";
      row.reason = `${row.reason} — live provider snapshot unavailable`;
      continue;
    }
    if ((inputs.liveProviders as string[]).includes(providerOf(row.model))) {
      row.state = "accepted";
      row.reason = `${row.reason}; provider "${providerOf(row.model)}" is live`;
      accepted = row;
      break;
    }
    row.state = "skipped";
    row.reason = `${row.reason} — no live credential for provider "${providerOf(row.model)}"`;
  }

  const top = chain[0];
  if (accepted) {
    const downgraded = accepted !== top;
    const [providerID, ...rest] = accepted.model.split("/");
    const announcement = downgraded
      ? `Model routing: ${role} wanted ${top.model} (${top.tier}) but ${top.reason} — ` +
        `dispatching ${accepted.model} (${accepted.tier}).`
      : null;
    return {
      role,
      outcome: "model",
      model: accepted.model,
      providerID: providerID ?? null,
      modelID: rest.join("/") || null,
      tier: accepted.tier,
      reason: accepted.reason,
      chain,
      announcement,
    };
  }

  if (chain.length === 0) {
    // Zero-config: the default tier IS today's dispatch — quiet by design.
    return {
      role,
      outcome: "inherit",
      model: null,
      providerID: null,
      modelID: null,
      tier: "default",
      reason: "no routing configured — this session's model",
      chain,
      announcement: null,
    };
  }
  const reasons = chain.map((r) => `${r.model} (${r.tier}): ${r.reason}`).join("; ");
  return {
    role,
    outcome: "inherit",
    model: null,
    providerID: null,
    modelID: null,
    tier: "default",
    reason: `no routing candidate is dispatchable — ${reasons}; using this session's model`,
    chain,
    announcement: `Model routing: ${role} — no candidate is dispatchable (${reasons}) — using this session's model.`,
  };
}

// ── the drift indicator ──────────────────────────────────────────────────────

export interface DriftInfo {
  drifted: boolean;
  /** The current tuned default for the role (null = the tuned seat is
   *  absent — S4 supplies it; the reset affordance renders the seat then). */
  tuned_model: string | null;
}

/** A user-set row diverging from the current tuned default shows drift +
 *  the reset-to-tuned affordance. Tuned absent → no drift (nothing to
 *  diverge from — the seat renders empty, never a fabricated comparison). */
export function driftOf(role: string, prefs: RoutingPrefs, tuned?: Record<string, string> | null): DriftInfo {
  const tunedModel = tuned?.[role];
  if (typeof tunedModel !== "string") return { drifted: false, tuned_model: null };
  const user = prefs.roles[role];
  return { drifted: user !== undefined && user !== tunedModel, tuned_model: tunedModel };
}

// ── the dispatch seam ────────────────────────────────────────────────────────

export interface SpawnRouting {
  /** The resolved model for the spawn call, or null → the caller computes
   *  today's model expression unchanged (byte-identity). */
  model: { providerID: string; modelID: string } | null;
  /** The resolution when routing was CONSULTED and configured (non-empty
   *  chain); null = byte-identity (nothing to surface). */
  resolution: RoutingResolution | null;
}

/** The dispatch seam's one entry point: what model should this spawn carry?
 *
 *  - No role (agent: null) → not consulted (server default, today's path).
 *  - An explicit model arg IS the hand-set for THIS dispatch — the resolver
 *    is unconsulted (null resolution, byte-identity summary). The arg
 *    arrives in either the raw string or the parsed {providerID, modelID}
 *    shape (parseSpawnArgs's output — both transports).
 *  - Anything else resolves through the chain over the ops-dir seats; ANY
 *    internal failure fails safe to today's dispatch — a routing defect
 *    must never block a spawn.
 */
export function routeSpawnModel(args: {
  agent: string | null;
  explicitModel?: string | { providerID: string; modelID: string } | null;
  agentsDir?: string | null;
  opsEnv?: NodeJS.ProcessEnv;
  fleetSession?: boolean;
}): SpawnRouting {
  try {
    const explicit = args.explicitModel;
    const hasExplicit =
      (typeof explicit === "string" && explicit.trim() !== "") ||
      (explicit !== null && typeof explicit === "object" && typeof explicit.providerID === "string" && explicit.providerID !== "");
    if (!args.agent || args.agent.trim() === "" || hasExplicit) {
      return { model: null, resolution: null };
    }
    const env = args.opsEnv ?? process.env;
    const agentsDir = args.agentsDir ?? null;
    const role = args.agent.trim();
    const prefs = readRoutingPrefs(routingPrefsFile(env));
    const liveProviders = readLiveProviders(routingSnapshotFile(env));
    const resolution = resolveRoleRoute({
      role,
      prefs,
      handSetModel: agentsDir ? handSetCardModel(agentsDir, role) : null,
      classes: agentsDir ? suggestedClassesForRole(agentsDir, role) : [],
      tuned: readTunedTable(tunedTableFile(env)),
      fleetLocked: readFleetLock(fleetLockFile(env)),
      fleetSession: args.fleetSession === true,
      liveProviders,
    });
    if (resolution.chain.length === 0) return { model: null, resolution: null }; // byte-identity
    if (resolution.outcome === "model" && resolution.providerID && resolution.modelID) {
      return { model: { providerID: resolution.providerID, modelID: resolution.modelID }, resolution };
    }
    return { model: null, resolution };
  } catch {
    return { model: null, resolution: null };
  }
}

/** The spawn summary's routing note — appended when routing was consulted
 *  with a non-empty chain (never in the zero-config case: byte-identity). */
export function routingSummaryLine(resolution: RoutingResolution): string {
  if (resolution.announcement) return resolution.announcement;
  if (resolution.outcome === "model") {
    return `[model routing] ${resolution.role} → ${resolution.model} (${resolution.tier})`;
  }
  return `[model routing] ${resolution.role}: ${resolution.reason}`;
}
