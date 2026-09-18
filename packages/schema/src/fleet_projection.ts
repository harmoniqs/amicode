// The fleet projection reader (amicode#1068, fleet rearchitect P3b-1; spec
// spec-20260913-114814 §3 D1, invariant 5) — the amicode-side consumer of
// amicissimo's fleet-authority projection document (contract v1).
//
// The projection FORMAT is owned by amicissimo's fleet_authority package
// (Python, amicissimo#412/#413): its `contract.py` is the authority and this
// module MIRRORS it — the TS reader consumes, never redefines. A field that
// is unclear here is unclear because the Python was not read first; the
// companion entry point (`python3 -m fleet_authority`, amicissimo#414)
// publishes; this package reads + renders.
//
// What v1 covers here (the Python contract module's own surface, transposed):
// - **The read entry point.** `readProjection` is the ONE gate a consumer
//   calls on a fetched projection (path or in-memory object). It validates
//   the envelope — contract_version first, then schema_version — and rejects
//   anything it cannot speak LOUDLY: a `FleetContractVersionError` naming BOTH
//   the rejected version and this consumer's version. A missing version is
//   never assumed current; a future version is never silently coerced.
// - **The epoch semantics (spec D1).** A projection's freshness is
//   PUBLISHER-COMPUTED: a monotonic counter bound to a hub-instance epoch (a
//   UUID minted at store creation; a re-image = a new store = a new epoch).
//   `freshnessBetween` is the ONLY freshness comparison a consumer makes:
//   same epoch + higher counter → "fresh"; equal counter → "stale";
//   cross-epoch (or a counter that went backwards) → "unknown" — force
//   refetch + surface, never a false-fresh badge. Consumers NEVER compute
//   age from a local wall clock (D1); the publisher's `published_at` stamp is
//   provenance, not a freshness input. This module holds no clock at all.
// - **Provenance rendering.** Every section stamps its `source` (where it
//   came from) and `parsed_from` (what it was parsed from). Provenance is
//   METADATA beside the value — `renderFleetStatus` prints it on its own
//   line, and it never merges into the data. Absent sections render the
//   base defaults (mode absent = standalone, posture absent = ok — the
//   post-amendment ADR-0005 vocabulary), never invented values.
//
// Placement: this module lives in @amicode/schema because the repo's
// convention puts cross-package shared contract code here — the extension's
// P3b-2 consumer and amico-run's verb both import from the package root
// (the documented seam `validate`/`mode_registry`/`skill_revision` already
// established). Fleet-class IMPLEMENTATION stays amicissimo overlay content
// (spec R1); a reader is a consumer.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FLEET_CONTRACT_VERSION = 1;

/** The stable projection-cache convention's path fragment (amicode#1106, fleet
 *  rearchitect P3b-2): the verb refreshes a published, contract-validated
 *  projection at `<home>/.amico/ops/fleet/projection.json` — the live-layout
 *  precedent (beside fleet.json, which only amicissimo's ONE parser reads) —
 *  and every amicode consumer (extension, installer, guard) reads THAT
 *  artifact, never the raw file. Scripts without a TS runtime compose it from
 *  $HOME with this exact fragment. */
export const FLEET_PROJECTION_CACHE_RELPATH = join(".amico", "ops", "fleet", "projection.json");

/** #1194: the machine's fleet topology file — the human-confirmed membership
 *  record the ONE parser reads (amicissimo's fleet_authority). Lives beside
 *  the projection cache; the publisher's --topology source on enrolled
 *  machines. Absent = unenrolled (the honest base-default standalone). */
export const FLEET_TOPOLOGY_RELPATH = join(".amico", "ops", "fleet", "fleet.json");

/** The cache path under a given home (default: the process home). ONE
 *  definition, consumed by the verb (writer) and the extension (reader). */
export function fleetProjectionCachePath(home: string = homedir()): string {
  return join(home, FLEET_PROJECTION_CACHE_RELPATH);
}

/** The topology path under a given home (default: the process home). ONE
 *  definition, consumed by the verb (the publisher's --topology source). */
export function fleetTopologyPath(home: string = homedir()): string {
  return join(home, FLEET_TOPOLOGY_RELPATH);
}

export const SUPPORTED_PROJECTION_SCHEMA_VERSIONS: readonly number[] = [1];

export const MODE_VOCABULARY = ["standalone", "fleet"] as const;
export const POSTURE_VOCABULARY = ["ok", "degraded", "hub-down"] as const;

/** The D1 freshness verdict. "unknown" means: cross-epoch or rewind — the
 *  comparison says nothing trustworthy, so the consumer force-refetches and
 *  surfaces; it must never render a false-fresh badge. */
export type FleetFreshness = "fresh" | "stale" | "unknown";

/** A versioned-contract rejection. The message ALWAYS names both versions —
 *  the seen one and this consumer's — the rejection is loud, never a silent
 *  coercion or a silent swallow. Mirrors the Python `ContractVersionError`. */
export class FleetContractVersionError extends Error {
  /** The contract_version the document carried (undefined when absent). */
  readonly seen: unknown;

  constructor(seen: unknown) {
    const described = seen === undefined ? "absent (no contract_version field)" : `v${String(seen)}`;
    super(
      `projection carries contract ${described}; this consumer speaks ` +
        `v${FLEET_CONTRACT_VERSION} — refusing loudly (never silently coerced)`,
    );
    this.name = "FleetContractVersionError";
    this.seen = seen;
  }
}

// ── the envelope types (permissive on purpose: the reader validates the
// version gates loudly and renders everything else honestly — it does not
// invent a second, stricter format the authority does not own) ────────────

export interface FleetProvenance {
  /** Where the section came from (the file/surface it was parsed from). */
  source?: unknown;
  /** What it was parsed from — the actual fields present. */
  parsed_from?: unknown;
}

export interface FleetSection {
  /** The carried value — EXACTLY what the publisher emitted, provenance never
   *  merged in. */
  value?: unknown;
  /** Metadata BESIDE the value, never inside it. */
  provenance?: FleetProvenance;
}

export interface FleetFreshnessStamp {
  counter?: unknown;
  hub_epoch?: unknown;
}

export interface FleetProjection {
  schema_version?: unknown;
  contract_version?: unknown;
  publisher?: { identity?: unknown; published_at?: unknown };
  freshness?: FleetFreshnessStamp;
  sections?: Record<string, FleetSection>;
  [key: string]: unknown;
}

/** Read one projection document (a file path or an in-memory object) under
 *  the contract. Returns the document unchanged when it is lawful; throws
 *  `FleetContractVersionError` for any contract-version mismatch (missing,
 *  stale, or future — each naming both versions) and an `Error` for a schema
 *  version this contract does not speak or a document that is not a JSON
 *  object. Mirrors the Python `read_projection` gate order exactly:
 *  contract_version first, then schema_version. */
export function readProjection(source: string | Record<string, unknown>): FleetProjection {
  let doc: unknown;
  if (typeof source === "string") {
    doc = JSON.parse(readFileSync(source, "utf8"));
  } else {
    doc = source;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`projection document is not a JSON object: ${typeName(doc)}`);
  }
  const carrier = doc as FleetProjection;
  const seen = carrier.contract_version;
  if (seen !== FLEET_CONTRACT_VERSION) {
    throw new FleetContractVersionError(seen);
  }
  const schema = carrier.schema_version;
  if (!(SUPPORTED_PROJECTION_SCHEMA_VERSIONS as readonly unknown[]).includes(schema)) {
    throw new Error(
      `projection carries unsupported schema_version ${describeValue(schema)}; ` +
        `this contract speaks ${SUPPORTED_PROJECTION_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
  return carrier;
}

/** The one freshness comparison a consumer makes (spec §3 D1). Cross-epoch is
 *  ALWAYS "unknown" — the re-image case: the counter reset, so a naive
 *  comparison would mislabel either side. A counter that went backwards
 *  within one epoch is likewise "unknown" (monotonic is the contract;
 *  backwards means something this contract cannot read, not something it
 *  should trust). Absent freshness fields compare unknown — never a crash,
 *  never silently fresh. */
export function freshnessBetween(previous: FleetProjection | null, fetched: FleetProjection): FleetFreshness {
  if (previous === null) return "fresh";
  const fresh = (fetched.freshness ?? {}) as FleetFreshnessStamp;
  const prev = (previous.freshness ?? {}) as FleetFreshnessStamp;
  if (fresh.hub_epoch !== prev.hub_epoch) return "unknown";
  if (!isCounter(fresh.counter) || !isCounter(prev.counter)) return "unknown";
  if (fresh.counter > prev.counter) return "fresh";
  if (fresh.counter === prev.counter) return "stale";
  return "unknown";
}

/** The surfaced text for a verdict: unknown MUST be surfaced with its
 *  force-refetch instruction, stale says what it is, fresh stays quiet
 *  (no badge noise). */
export function freshnessAdvisory(verdict: FleetFreshness): string {
  if (verdict === "unknown") {
    return "unknown freshness (cross-epoch or rewind) — force refetch and surface; never a false-fresh badge (spec §3 D1)";
  }
  if (verdict === "stale") return "stale — same counter as the previous fetch; nothing new was published";
  return "";
}

/** Render a status summary from a lawful projection: every section's value
 *  with its provenance on its own line (source + parsed-from, never merged
 *  into the data), the carried freshness fields verbatim (counter + epoch,
 *  published_at as the publisher's stamp), and — when a previous projection
 *  is given — the D1 verdict with its advisory surfaced. Absent sections
 *  render the base defaults (mode = standalone, posture = ok), absent
 *  envelope fields render as absent: honest renderings, never inventions,
 *  never a wall-clock age (this module holds no clock at all). */
export function renderFleetStatus(proj: FleetProjection, previous: FleetProjection | null = null): string {
  const sections = proj.sections ?? {};
  const lines: string[] = [];

  const publisher = proj.publisher ?? {};
  const identity = publisher.identity === undefined ? "unknown" : String(publisher.identity);
  const stamp = publisher.published_at === undefined ? "unstamped" : String(publisher.published_at);
  lines.push(
    `fleet status — contract v${String(proj.contract_version)}, schema v${String(proj.schema_version)}, publisher: ${identity} (${stamp})`,
  );

  // mode + posture always render — base-defaultable scalars (post-amendment
  // ADR-0005 vocabulary; mode absent = standalone, posture absent = ok).
  lines.push(...renderScalarSection("mode", sections.mode, MODE_VOCABULARY, "standalone", "mode absent = standalone"));
  lines.push(...renderScalarSection("posture", sections.posture, POSTURE_VOCABULARY, "ok", "posture absent = ok"));

  // topology / health / locks render ONLY when their section is present —
  // a field the publisher did not carry stays absent (additive-optional;
  // the consumer falls back to base defaults, never invents).
  if (sections.topology !== undefined) {
    lines.push(`topology: ${compactJson(sections.topology.value)}`);
    lines.push(...provenanceLines(sections.topology));
  }
  if (sections.health !== undefined) {
    lines.push(`health: ${compactJson(sections.health.value)}`);
    lines.push(...provenanceLines(sections.health));
  }
  if (sections.locks !== undefined) {
    const rows = rowsOf(sections.locks.value);
    lines.push(`locks: ${rows} row(s) — a rendering, never the enforcement`);
    lines.push(...provenanceLines(sections.locks));
  }

  const fresh = proj.freshness ?? {};
  if (fresh.counter === undefined || fresh.hub_epoch === undefined) {
    lines.push("freshness: absent (no carried freshness fields to render — refusing to guess)");
  } else {
    lines.push(`freshness: counter ${String(fresh.counter)} @ epoch ${String(fresh.hub_epoch)}`);
  }
  if (previous !== null) {
    const verdict = freshnessBetween(previous, proj);
    lines.push(`freshness verdict: ${verdict}`);
    const advisory = freshnessAdvisory(verdict);
    if (advisory !== "") lines.push(`  ${advisory}`);
  }
  return lines.join("\n");
}

// ── the base-tier producer (ADR 0023) ───────────────────────────────────────
// A public floor UNDER the amicissimo authority. When the authority is
// unavailable (no entitlement / no checkout) but the machine carries a
// fleet.json declaring a real role, `amico fleet status --projection` renders a
// minimal contract-v1 projection ITSELF from that membership file, so the base
// (public) product still gets an enforced client (role → guard exit 1) without
// amicissimo. This is a PRODUCER; every consumer still reads only the projection
// through readProjection (the one-reader invariant is untouched). amicissimo
// stays canonical: it runs whenever present and fills the rich sections; the
// base tier fills only mode + topology + a stable local epoch.

/** The base-tier publisher's stamped identity — a reader can always tell a base
 *  floor from amicissimo's authority (never merged, always visible in provenance). */
export const BASE_TIER_PUBLISHER_IDENTITY = "amicode-base-tier";

/** The machine-local membership record's shape (fleet.json), tolerantly parsed. */
export interface BaseTopologyCanonical {
  host?: string;
  port?: number;
  sshAlias?: string;
}
export interface BaseTopology {
  role: string;
  canonical?: BaseTopologyCanonical;
}

/** Parse a raw fleet.json into a {role, canonical}, or null when it carries no
 *  usable role (unparseable, not an object, or role absent). Null = the caller
 *  keeps the honest bootstrap (never a base projection invented from nothing). */
export function parseFleetTopology(raw: string): BaseTopology | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const role = typeof o.role === "string" && o.role.length > 0 ? o.role : undefined;
  if (role === undefined) return null;
  let canonical: BaseTopologyCanonical | undefined;
  const c = o.canonical;
  if (c !== null && typeof c === "object" && !Array.isArray(c)) {
    const cc = c as Record<string, unknown>;
    canonical = {};
    if (typeof cc.host === "string") canonical.host = cc.host;
    if (typeof cc.port === "number" && Number.isFinite(cc.port)) canonical.port = cc.port;
    if (typeof cc.sshAlias === "string") canonical.sshAlias = cc.sshAlias;
  }
  return { role, canonical };
}

export interface BaseProjectionOpts {
  /** A STABLE per-machine epoch (persisted, reused across calls) — so
   *  freshnessBetween compares within one epoch and never loops on "unknown". */
  epoch: string;
  /** A monotonic publish counter (the publish wall-second is the default source). */
  counter: number;
  /** ISO publish stamp — provenance only, never a freshness input (D1). */
  publishedAt: string;
}

/** Render a minimal contract-v1 projection from a machine's fleet.json topology.
 *  Fills mode (fleet unless role=standalone) + posture (ok) + topology
 *  (role + canonical), stamped as the base-tier producer. Everything the
 *  amicissimo authority would add (health, locks, program, org) stays absent —
 *  the floor, not the rich surface. */
export function buildBaseProjection(topo: BaseTopology, opts: BaseProjectionOpts): FleetProjection {
  const mode = topo.role === "standalone" ? "standalone" : "fleet";
  const provenance: FleetProvenance = {
    source: "fleet.json",
    parsed_from: "amicode base-tier producer (ADR 0023 — no amicissimo authority present)",
  };
  const topologyValue: Record<string, unknown> = { role: topo.role };
  if (topo.canonical !== undefined) topologyValue.canonical = topo.canonical;
  return {
    contract_version: FLEET_CONTRACT_VERSION,
    schema_version: SUPPORTED_PROJECTION_SCHEMA_VERSIONS[0],
    publisher: { identity: BASE_TIER_PUBLISHER_IDENTITY, published_at: opts.publishedAt },
    freshness: { counter: opts.counter, hub_epoch: opts.epoch },
    sections: {
      mode: { value: mode, provenance },
      posture: { value: "ok", provenance },
      topology: { value: topologyValue, provenance },
    },
  };
}

// ── internals ───────────────────────────────────────────────────────────────

/** Mirrors the Python gate's `isinstance(counter, int)`: an integer counter,
 *  and only an integer counter, orders freshness. Anything else — a float, a
 *  string, absent — is unknown freshness, never a crash, never silently
 *  coerced. */
function isCounter(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** A base-defaultable scalar section (mode / posture): the carried value, a
 *  loud surface when it sits outside the closed vocabulary (surfaced, never
 *  silently remapped), and its provenance — or the base default with
 *  base-default provenance when the section is absent. */
function renderScalarSection(
  name: string,
  section: FleetSection | undefined,
  vocabulary: readonly string[],
  baseDefault: string,
  baseNote: string,
): string[] {
  const lines: string[] = [];
  if (section === undefined) {
    lines.push(`${name}: ${baseDefault}`);
    lines.push(`  provenance — source: unknown; parsed from: base default (${baseNote})`);
    return lines;
  }
  const value = section.value === undefined ? baseDefault : String(section.value);
  lines.push(`${name}: ${value}`);
  if (!(vocabulary as readonly unknown[]).includes(section.value)) {
    lines.push(`  warning: value ${describeValue(section.value)} is outside the ${name} vocabulary ${vocabulary.join(", ")} — surfaced, never silently remapped`);
  }
  lines.push(...provenanceLines(section));
  return lines;
}

/** The provenance line(s) for a section: source + parsed-from as METADATA
 *  beside the value, never merged into it. */
function provenanceLines(section: FleetSection): string[] {
  const p = section.provenance ?? {};
  const source = p.source === undefined || p.source === null ? "unknown" : String(p.source);
  const parsedFrom = p.parsed_from === undefined || p.parsed_from === null ? "unknown" : String(p.parsed_from);
  return [`  provenance — source: ${source}; parsed from: ${parsedFrom}`];
}

/** The lock row count — the section's value carries `{rows: [...]}`; anything
 *  else renders as 0 rows named honestly, never a crash. */
function rowsOf(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const rows = (value as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows.length : 0;
}

function compactJson(v: unknown): string {
  return JSON.stringify(v) ?? "absent";
}

function describeValue(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

function typeName(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}
