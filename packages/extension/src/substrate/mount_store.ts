/** Armonia mount-stack discovery + precedence (spec-20260707-002846 Component 1
 *  — "bootstrap parity", read side).
 *
 *  A TypeScript port of the amico-plugin session-start hook's mount discovery
 *  (the PARITY ORACLE: ~/harmoniqs/amico-plugin-vault-cli/hooks/session-start,
 *  branch feat/amico-vault-mounts-toml / PR #27, lines 53–232). Same ranks, same
 *  skip/rescue semantics, same unlisted-append behavior.
 *
 *  Canonical kind ranks follow the APPROVED vault-CLI spec
 *  (spec-20260703-053956), NOT the Ombra draft's table: the draft swapped
 *  team/restricted; we keep restricted(3) < team(4) (spec correction — see the
 *  parity PR body). Ranks:
 *      personal 0 · engagement 1 · project 2 · restricted 3 · team 4 · public 5 · other 6
 *  Writable-by-default: personal/engagement/project = rw; the rest = ro.
 *
 *  Everything here is read-only and failure-tolerant: a missing vaults root,
 *  unreadable marker, or unparseable manifest yields the empty/degraded value
 *  and a warning — never a throw (the session must boot regardless).
 *
 *  TWIN / UNIFY-LATER: a second copy of this resolver lives in
 *  amico-run (packages/amico-run/src/mounts.ts) with the same API + semantics
 *  plus an $AMICO_VAULTS_ROOT/$AMICO_MOUNTS_TOML env seam (its verb tests cross a
 *  child-process boundary; this in-process vitest twin needs no env seam). The
 *  duplication is deliberate short-term (Ombra spec chose extension-resident
 *  mount discovery; depth-1 §7.3 wants the CLI to own it long-term). Unify-later
 *  follow-up: fold both onto the amico-run implementation once the CLI is the
 *  single retrieval spine. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";

export interface Mount {
  /** Resolved mount name (marker `name`, else dir basename). */
  name: string;
  /** Mount kind (marker `kind`, overridable by a matching manifest entry). */
  kind: string;
  /** Absolute path to the vault dir (the dir holding `.amico-vault.toml`). */
  path: string;
  /** Writable-by-default posture (rw when true, ro when false). */
  writable: boolean;
}

export interface MountStack {
  /** Mounts in read precedence (top = highest precedence). */
  mounts: Mount[];
  /** Non-fatal skip/degrade notices (mirror the oracle's `⚠ skipped:` lines). */
  warnings: string[];
}

export function defaultVaultsRoot(): string {
  return path.join(os.homedir(), ".amico", "vaults");
}

export function defaultMountsTomlPath(): string {
  return path.join(os.homedir(), ".amico", "mounts.toml");
}

/** Canonical kind order (vault-CLI spec-20260703-053956). Unknown → 6. */
function kindRank(kind: string): number {
  switch (kind) {
    case "personal":
      return 0;
    case "engagement":
      return 1;
    case "project":
      return 2;
    case "restricted":
      return 3;
    case "team":
      return 4;
    case "public":
      return 5;
    default:
      return 6;
  }
}

/** Writability default by kind (oracle lines 142–145). */
function writableByKind(kind: string): boolean {
  return kind === "personal" || kind === "project" || kind === "engagement";
}

interface ManifestEntry {
  id?: string;
  kind?: string;
  path?: string;
  writable?: boolean | string;
}

/** Parse `~/.amico/mounts.toml`'s `[[mount]]` array. Missing file → []; a parse
 *  failure is tolerated (→ [] + warning) so a garbled manifest degrades to
 *  kind-rank ordering rather than bricking discovery. */
function loadManifest(mountsTomlPath: string, warnings: string[]): ManifestEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(mountsTomlPath, "utf8");
  } catch {
    return []; // absent manifest is the common case, not a warning
  }
  try {
    const parsed = parseToml(text) as { mount?: ManifestEntry[] };
    return Array.isArray(parsed.mount) ? parsed.mount : [];
  } catch {
    warnings.push(`mounts.toml unparseable at ${mountsTomlPath} — falling back to kind-rank ordering`);
    return [];
  }
}

/** The manifest match key for a mount entry: its `id`, else its `path` basename
 *  (oracle ordering match, hook lines 162–166 / 173). */
function manifestKey(entry: ManifestEntry): string | undefined {
  if (typeof entry.id === "string" && entry.id !== "") return entry.id;
  if (typeof entry.path === "string" && entry.path !== "") return path.basename(entry.path);
  return undefined;
}

function manifestWritable(entry: ManifestEntry): boolean | undefined {
  if (entry.writable === true || entry.writable === "true") return true;
  if (entry.writable === false || entry.writable === "false") return false;
  return undefined;
}

/** Discover + order the Armonia mount stack.
 *
 *  Discovery: every dir under `vaultsRoot` with an `.amico-vault.toml` marker.
 *  `name` defaults to the dir basename. Kind resolution order (oracle lines
 *  125–133): the manifest `kind` override applies BEFORE the missing-kind skip —
 *  a marker with no `kind` but a matching manifest entry is RESCUED with the
 *  manifest kind; only a mount with no kind from either source is skipped.
 *  Duplicate resolved name → the later discovery is skipped + warned.
 *
 *  Ordering: with a manifest present, its array order governs (each entry
 *  matched by id-or-path-basename against a discovered mount); unlisted mounts
 *  append in DISCOVERY order (NOT kind-rank — oracle lines 181–187). Absent
 *  manifest → kind-rank then name. */
export function resolveMountStack(
  vaultsRoot: string = defaultVaultsRoot(),
  mountsTomlPath: string = defaultMountsTomlPath(),
): MountStack {
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(vaultsRoot).sort(); // sorted = deterministic discovery order (matches the glob)
  } catch {
    return { mounts: [], warnings }; // missing/unreadable root → empty stack, no throw
  }

  const manifest = loadManifest(mountsTomlPath, warnings);
  // Kind/writable override is keyed on id === name (oracle manifest_field, strict id).
  const overrideById = new Map<string, ManifestEntry>();
  for (const e of manifest) {
    if (typeof e.id === "string" && e.id !== "") overrideById.set(e.id, e);
  }

  const discovered: Mount[] = [];
  const seen = new Set<string>();
  for (const base of entries) {
    const dir = path.join(vaultsRoot, base);
    const marker = path.join(dir, ".amico-vault.toml");
    let markerText: string;
    try {
      markerText = fs.readFileSync(marker, "utf8");
    } catch {
      warnings.push(`skipped '${base}': no .amico-vault.toml marker`);
      continue;
    }
    let kind = "";
    let name = base;
    try {
      const m = parseToml(markerText) as { kind?: unknown; name?: unknown };
      if (typeof m.kind === "string") kind = m.kind;
      if (typeof m.name === "string" && m.name !== "") name = m.name;
    } catch {
      warnings.push(`skipped '${base}': .amico-vault.toml is unparseable`);
      continue;
    }
    // Manifest kind override BEFORE the missing-kind skip (oracle rescue rule).
    const override = overrideById.get(name);
    if (override && typeof override.kind === "string" && override.kind !== "") kind = override.kind;
    if (kind === "") {
      warnings.push(`skipped '${base}': marker missing 'kind'`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`skipped '${base}': duplicate id '${name}'`);
      continue;
    }
    seen.add(name);
    let writable = writableByKind(kind);
    const w = override ? manifestWritable(override) : undefined;
    if (w !== undefined) writable = w;
    discovered.push({ name, kind, path: dir, writable });
  }

  const ordered = manifest.length > 0 ? orderByManifest(discovered, manifest) : orderByKindRank(discovered);
  return { mounts: ordered, warnings };
}

/** Manifest array order, then unlisted mounts in discovery order (oracle 157–188). */
function orderByManifest(discovered: Mount[], manifest: ManifestEntry[]): Mount[] {
  const ordered: Mount[] = [];
  const emitted = new Set<string>();
  for (const entry of manifest) {
    const key = manifestKey(entry);
    if (key === undefined) continue;
    for (const m of discovered) {
      if (emitted.has(m.name)) continue;
      if (m.name === key || path.basename(m.path) === key) {
        ordered.push(m);
        emitted.add(m.name);
      }
    }
  }
  for (const m of discovered) {
    if (!emitted.has(m.name)) {
      ordered.push(m);
      emitted.add(m.name);
    }
  }
  return ordered;
}

/** Kind rank, then name (oracle `sort -k1,1n -k2,2`). */
function orderByKindRank(discovered: Mount[]): Mount[] {
  return [...discovered].sort((a, b) => {
    const ra = kindRank(a.kind);
    const rb = kindRank(b.kind);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** The personal mount (first `kind === "personal"` in stack order), or
 *  undefined. This is what the config funnel maps to the legacy `vaultDir`. */
export function personalMount(stack: MountStack): Mount | undefined {
  return stack.mounts.find((m) => m.kind === "personal");
}
