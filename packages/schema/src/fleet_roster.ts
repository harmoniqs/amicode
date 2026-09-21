// The fleet roster contract (amicode#1318, fleet capability model + host-owned
// roster; ADR 0026) — an amicode-OWNED, schema-versioned roster that lives on
// the Canonical Server at `~/.amico/ops/fleet/roster.json`. It is the sibling
// of the fleet projection reader (fleet_projection.ts), with one deliberate
// difference: the projection MIRRORS amicissimo's Python contract (a consumer,
// never a redefiner), whereas the roster FORMAT is amicode's own — `fleet.json`
// is untouched (ADR 0023's one-parser invariant holds; zero amicissimo change).
//
// What the roster is, and is not:
// - It is a fleet-WIDE device roster: one row per machine, each machine the
//   single writer of its OWN row (a registry/heartbeat model — no dual-writer
//   conflict). The authoritative per-machine role stays that machine's own
//   `fleet.json`; the row's `server_mode` is the reconciled, read-only mirror.
// - It is NOT a second serve-stance authority: `Server mode`
//   (standalone|server|client) remains the only driver of guard/tunnel/hub
//   behavior. `capabilities[]` is an ORTHOGONAL, OPEN set — two known,
//   behavior-adjacent tags (`compute`, `roaming`) plus any free descriptive
//   tag, which round-trips verbatim and carries no behavioral meaning.
//
// Placement: @amicode/schema, the repo's home for cross-package shared contract
// code — the extension's roster route (reader + self-report writer) and the
// reachability status job both consume this ONE definition, exactly as
// fleet_projection's reader is shared across the verb and the extension.
import { homedir } from "node:os";
import { join } from "node:path";

/** The roster document's schema version — bumped independently of the
 *  projection's contract (a different, amicode-owned artifact). */
export const ROSTER_SCHEMA_VERSION = 1;

/** The per-device reachability tri-state. DISTINCT from the link-health posture
 *  vocabulary (`ok/degraded/hub-down`, fleet_projection.ts), which is about THIS
 *  machine's link to the hub — `health` here is a peer's reachability as the
 *  status job probed it (ADR 0026 §Decision.2). Closed on purpose: a value
 *  outside it is a malformed row, never coerced. */
export const HEALTH_VOCABULARY = ["reachable", "degraded", "down"] as const;
export type RosterHealth = (typeof HEALTH_VOCABULARY)[number];

/** The KNOWN, behavior-adjacent capability tags (ADR 0026 §Decision.1; ADR
 *  0027 §5/D8 adds the third): `compute` (a solve-target hint — declared-but-
 *  inert until a fleet-peer executor exists, an explicit non-goal here),
 *  `roaming` (a transport hint that defaults a machine to tailscale), and
 *  `serving` (#1341 — a peer advertises its already-running engine; a
 *  placement-ready fact a future scheduler reads via `placementDescriptor`,
 *  orthogonal to `server_mode`, which remains the sole serve-stance
 *  authority). This is NOT a closed set: it names only the tags with meaning.
 *  Any OTHER tag is a valid descriptive label — the capability set is OPEN,
 *  and an arbitrary tag round-trips verbatim (parseRosterRow never rejects a
 *  tag for being unknown). */
export const KNOWN_CAPABILITY_TAGS = ["compute", "roaming", "serving"] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITY_TAGS)[number];

/** Whether a tag is one of the known behavior tags. A false answer is NOT a
 *  rejection — a descriptive tag is fully valid; this only says "no built-in
 *  meaning attaches" (the UI renders an honest "descriptive" affordance). */
export function isKnownCapability(tag: string): tag is KnownCapability {
  return (KNOWN_CAPABILITY_TAGS as readonly string[]).includes(tag);
}

/** The suggested `device_type` vocabulary — the fleet sidebar's type-pill
 *  labels (#1359). Like `capabilities`, this is an OPEN set: it names the
 *  three form factors the pill knows how to talk about, but an arbitrary
 *  value still round-trips through `parseRosterRow` and renders (just without
 *  special-cased styling). */
export const KNOWN_DEVICE_TYPES = ["server", "desktop", "laptop"] as const;
export type KnownDeviceType = (typeof KNOWN_DEVICE_TYPES)[number];

// ── the shared device-identity classifiers (#1371 / #1368, ADR 0028) ─────────
// The PURE core of a machine's self-report. The impure shell (execSync of
// scutil/system_profiler on darwin, hostnamectl/DMI on linux, the /proc/version
// read) stays in each node package (amico-run + the extension host) behind an
// injectable command-runner seam; all JUDGMENT lives here so the enroll producer
// and the extension self-row share ONE derivation and cannot drift. Every
// function is string-in/value-out — no `child_process`, no fs — keeping
// @amicode/schema side-effect-free (ADR 0028 §invariant 3).

/** Map a macOS `system_profiler SPHardwareDataType` "Model Name" value (e.g.
 *  "MacBook Pro", "Mac Studio") to the device-type vocabulary: MacBook* →
 *  `laptop`; iMac / Mac mini / Mac Studio / Mac Pro → `desktop`; anything else
 *  (or empty) → `undefined`. An honest abstention, never a guess — the fleet
 *  sidebar's type pill falls back to `server_mode` when this is undefined.
 *  Rehomed verbatim from the extension's `classifyDeviceType` inner match
 *  (#1359), now taking the extracted Model Name string (the impure caller does
 *  the `Model Name:` line extraction). */
export function classifyMacModel(modelName: string): KnownDeviceType | undefined {
  const model = (modelName ?? "").trim();
  if (!model) return undefined;
  if (/macbook/i.test(model)) return "laptop";
  if (/mac studio|imac|mac mini|mac pro/i.test(model)) return "desktop";
  return undefined;
}

/** Map a Linux chassis token (from `hostnamectl` chassis or the DMI
 *  chassis-type name) to the device-type vocabulary: `laptop`/`notebook`/
 *  `portable` → `laptop`; `desktop`/`tower` → `desktop`; `server`/`rack` →
 *  `server`; anything else → `undefined` (honest abstain). Case-insensitive. */
export function classifyLinuxChassis(chassis: string): KnownDeviceType | undefined {
  const c = (chassis ?? "").trim().toLowerCase();
  if (c === "laptop" || c === "notebook" || c === "portable") return "laptop";
  if (c === "desktop" || c === "tower") return "desktop";
  if (c === "server" || c === "rack") return "server";
  return undefined;
}

/** Prettify a raw hostname into a display name. Rule: strip from the first `.`
 *  onward ONLY when the remainder is a DNS-suffix-shaped label sequence (labels
 *  of `[A-Za-z0-9-]` joined by dots) — so `Mac.mynetworksettings.com → Mac` and
 *  `host.local → host`. A name that carries a space is treated as a human-set
 *  display name (a macOS ComputerName like "JJ's Mac Studio") and is left intact
 *  even if it contains a dot; a dot-free name is returned unchanged; `""` → `""`.
 *  Never fabricates — the fallback is always the raw input. */
export function normalizeDeviceName(raw: string): string {
  const s = raw ?? "";
  if (s === "") return "";
  // A space-bearing name is a display name, not a hostname — never strip it.
  if (/\s/.test(s)) return s;
  const dot = s.indexOf(".");
  if (dot < 0) return s; // dot-free — nothing to strip
  const head = s.slice(0, dot);
  const remainder = s.slice(dot + 1);
  // Strip the suffix only when the remainder is a DNS-suffix-shaped label run.
  if (head.length > 0 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(remainder)) {
    return head;
  }
  return s;
}

/** Detect whether a `/proc/version` string is a WSL kernel — true when it
 *  carries a Microsoft or WSL2 marker (case-insensitive), false otherwise.
 *  Extracted as a pure function from the proven inline regex in the extension's
 *  `detectWSLVersion` (`rebuild/host_matrix.ts`). A WSL machine abstains on
 *  device_type — the VM's chassis does not reflect the physical machine
 *  (ADR 0028 §Decision.3). */
export function isWslKernel(procVersion: string): boolean {
  const v = procVersion ?? "";
  return /microsoft/i.test(v) || /wsl2/i.test(v);
}

/** One roster row — the reconciled self-report of one machine. `server_mode`
 *  mirrors that machine's own fleet.json role (read-only here; the UI labels it
 *  "role"), `last_report` renders as "last-seen". Every field is a string
 *  except the open `capabilities[]`. */
export interface RosterRow {
  /** The single-writer key — a stable per-machine id. */
  machine_id: string;
  /** Human display name / nickname. */
  name: string;
  /** Read-only mirror of the machine's fleet.json serve-stance. */
  server_mode: string;
  /** The OPEN capability-tag set (known: compute, roaming; plus free tags). */
  capabilities: string[];
  /** The ssh target the reachability job probes (its fleet.json canonical alias). */
  sshAlias: string;
  /** The machine's transport hint (e.g. ssh, tailscale, local). */
  transport: string;
  /** ISO stamp of this self-report — provenance, rendered as "last-seen". */
  last_report: string;
  /** Per-device reachability, from the closed tri-state. */
  health: RosterHealth;
  /** Optional device form factor (e.g. server, desktop, laptop) — the fleet
   *  sidebar's type-pill source. Absent is lawful (a machine that hasn't
   *  detected/reported its form factor yet); the UI falls back to
   *  `server_mode` when unset. Open, like `capabilities` — an unrecognized
   *  value still round-trips (see KNOWN_DEVICE_TYPES). */
  device_type?: string;
}

// ── the placement-ready descriptor (#1341, ADR 0027 §5/D8) ──────────────────

/** The placement-ready descriptor a future scheduler reads off a roster row:
 *  is this machine serving, and is it reachable? Reach coordinates
 *  (`sshAlias`/`transport`) already live on the row — this helper does not
 *  duplicate them so much as CARRY them alongside the two derived placement
 *  facts, so a scheduler can act on one small, self-contained object instead
 *  of re-deriving `serving` from `capabilities[]` and `reachable` from
 *  `health` itself. Deliberately excludes `headroom` — ADR 0027 §5/D8 names
 *  it explicitly as a Horizon-2 field, not asserted here. This is placement
 *  data, not a display-only chip: it never derives from or feeds back into
 *  `server_mode`, which remains the sole serve-stance authority. */
export interface PlacementDescriptor {
  machine_id: string;
  /** Derived from `capabilities.includes("serving")` — never a separate field. */
  serving: boolean;
  /** Derived from `health === "reachable"` — the SAME closed tri-state every
   *  other roster consumer reads, never a second reachability signal. */
  reachable: boolean;
  sshAlias: string;
  transport: string;
}

/** Build the placement-ready descriptor by reading it off an already-valid
 *  `RosterRow` — a pure, side-effect-free projection (two calls on the same
 *  row are `toEqual`). Callers pass a `parseRosterRow`-validated row; this
 *  does not itself validate (that is `parseRosterRow`'s job). */
export function placementDescriptor(row: RosterRow): PlacementDescriptor {
  return {
    machine_id: row.machine_id,
    serving: row.capabilities.includes("serving"),
    reachable: row.health === "reachable",
    sshAlias: row.sshAlias,
    transport: row.transport,
  };
}

/** A parse outcome — a Result, never a throw: the self-report route collapses a
 *  malformed report into a fixed-string refusal (sibling discipline), so the
 *  contract must hand it a verdict, not an exception. */
export type ParseRosterRowResult = { ok: true; row: RosterRow } | { ok: false; error: string };

function isStringField(o: Record<string, unknown>, key: string): boolean {
  return typeof o[key] === "string";
}

/** Validate one candidate row against the contract and return a normalized row
 *  carrying EXACTLY the eight known fields (round-trips a well-formed row
 *  without loss; drops nothing it owns, invents nothing, and does not smuggle
 *  unknown keys through). Rejects — never coerces — a missing key, a non-string
 *  scalar, a non-string-array `capabilities`, or a `health` outside the closed
 *  tri-state. */
export function parseRosterRow(candidate: unknown): ParseRosterRowResult {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: `roster row is not a JSON object: ${describe(candidate)}` };
  }
  const o = candidate as Record<string, unknown>;
  for (const key of ["machine_id", "name", "server_mode", "sshAlias", "transport", "last_report"] as const) {
    if (!isStringField(o, key)) return { ok: false, error: `roster row: "${key}" must be a string` };
  }
  if (typeof o.machine_id === "string" && o.machine_id.trim() === "") {
    return { ok: false, error: `roster row: "machine_id" must be a non-empty string (the single-writer key)` };
  }
  if (!Array.isArray(o.capabilities) || !o.capabilities.every((c) => typeof c === "string")) {
    return { ok: false, error: `roster row: "capabilities" must be an array of strings` };
  }
  if (!(HEALTH_VOCABULARY as readonly unknown[]).includes(o.health)) {
    return {
      ok: false,
      error: `roster row: "health" must be one of ${HEALTH_VOCABULARY.join(", ")} (got ${describe(o.health)})`,
    };
  }
  if (o.device_type !== undefined && typeof o.device_type !== "string") {
    return { ok: false, error: `roster row: "device_type" must be a string when present (got ${describe(o.device_type)})` };
  }
  const row: RosterRow = {
    machine_id: o.machine_id as string,
    name: o.name as string,
    server_mode: o.server_mode as string,
    capabilities: (o.capabilities as string[]).slice(),
    sshAlias: o.sshAlias as string,
    transport: o.transport as string,
    last_report: o.last_report as string,
    health: o.health as RosterHealth,
    ...(typeof o.device_type === "string" ? { device_type: o.device_type } : {}),
  };
  return { ok: true, row };
}

// ── the roster document + single-writer upsert ──────────────────────────────

/** The on-disk roster document: a schema version + the fleet-wide rows. */
export interface RosterDocument {
  schema_version: number;
  rows: RosterRow[];
}

/** An empty, lawful roster (the absent-file / fresh-fleet state). */
export function emptyRoster(): RosterDocument {
  return { schema_version: ROSTER_SCHEMA_VERSION, rows: [] };
}

/** A document parse outcome — a Result, never a throw (the GET route collapses
 *  an absent/malformed store into an empty roster, honestly). */
export type ParseRosterDocumentResult = { ok: true; doc: RosterDocument } | { ok: false; error: string };

/** Validate a candidate roster document: an object with a numeric
 *  schema_version and an array of rows, each row lawful per parseRosterRow. A
 *  single bad row rejects the whole document (a partially-trusted roster is
 *  never silently half-loaded). */
export function parseRosterDocument(candidate: unknown): ParseRosterDocumentResult {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: `roster document is not a JSON object: ${describe(candidate)}` };
  }
  const o = candidate as Record<string, unknown>;
  if (typeof o.schema_version !== "number") {
    return { ok: false, error: `roster document: "schema_version" must be a number` };
  }
  if (!Array.isArray(o.rows)) {
    return { ok: false, error: `roster document: "rows" must be an array` };
  }
  const rows: RosterRow[] = [];
  for (let i = 0; i < o.rows.length; i++) {
    const parsed = parseRosterRow(o.rows[i]);
    if (!parsed.ok) return { ok: false, error: `roster document: rows[${i}] — ${parsed.error}` };
    rows.push(parsed.row);
  }
  return { ok: true, doc: { schema_version: o.schema_version, rows } };
}

/** The single-writer merge (ADR 0026 §Decision.2 — "a write only ever touches
 *  the reporting machine's own row"). Returns a NEW document in which the row
 *  matching `row.machine_id` is REPLACED in place (order preserved), or the row
 *  is appended when new. Every OTHER row is carried through unchanged — so a
 *  machine's self-report can never mutate a peer's row. */
export function upsertRosterRow(doc: RosterDocument, row: RosterRow): RosterDocument {
  let replaced = false;
  const rows = doc.rows.map((existing) => {
    if (existing.machine_id === row.machine_id) {
      replaced = true;
      return row;
    }
    return existing;
  });
  if (!replaced) rows.push(row);
  return { schema_version: doc.schema_version, rows };
}

// ── the roster-cache path convention (sibling of the projection cache) ───────

/** The stable roster-cache path fragment — beside the projection cache
 *  (fleet_projection's FLEET_PROJECTION_CACHE_RELPATH), on the Canonical
 *  Server. ONE definition consumed by the extension's route and the status
 *  job. */
export const FLEET_ROSTER_CACHE_RELPATH = join(".amico", "ops", "fleet", "roster.json");

/** The roster path under a given home (default: the process home). */
export function fleetRosterCachePath(home: string = homedir()): string {
  return join(home, FLEET_ROSTER_CACHE_RELPATH);
}

// ── internals ────────────────────────────────────────────────────────────────

function describe(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return JSON.stringify(v) ?? typeof v;
}
