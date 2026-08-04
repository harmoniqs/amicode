// The Armonia MOUNT-STACK resolver — the pure core that discovers the vaults
// mounted under `~/.amico/vaults/*`, applies the `~/.amico/mounts.toml` manifest
// (kind/writable override + ordering), and returns a precedence-ordered stack.
// Backs the mount-aware `amico vault` verbs (status/resolve/query) and the routed
// `note route` writer (plan Task 6; spec-20260703-053956 §"mounts.toml").
//
// TWIN: this is a deliberate short-term duplicate of the extension's
// `packages/extension/src/substrate/mount_store.ts` (same API, same semantics).
// The Ombra spec (spec-20260707-002846 C1) put the resolver extension-resident;
// the depth-1 redesign (spec-20260708-112732 §7.3) wants the CLI to own it
// long-term. UNIFY-LATER follow-up: collapse the two into one shared module once
// the extension can depend on amico-run. Keep the two byte-for-byte behaviorally
// identical until then — the ONLY intended delta is this file's env seam (below).
//
// CANONICAL: this module was ported from the amico-plugin session-start hook
// (branch feat/amico-vault-mounts-toml, PR #27) — that hook is now RETIRED with
// the plugin repo, and THIS port is the source of truth. Same ranks, same
// skip/rescue rules, same unlisted-append behavior. The canonical kind order
// follows the APPROVED vault-CLI spec (spec-20260703-053956), NOT the Ombra
// draft table — the Ombra draft swapped team/restricted; here restricted=3 <
// team=4 (spec correction).
//
//   kind        rank  writable(default)
//   personal    0     rw
//   engagement  1     rw
//   project     2     rw
//   restricted  3     ro
//   team        4     ro
//   public      5     ro
//   other       6     ro
//
// ENV SEAM (amico-run only; the extension twin needs none — it runs in-process
// vitest where function params suffice). b3's verb tests execute the esbuild
// bundle via `execFileSync`, so params can't reach fixtures — the defaults read
// `$AMICO_VAULTS_ROOT` / `$AMICO_MOUNTS_TOML` before `~/.amico/...`. Explicit
// params still win. `$AMICO_VAULT_DIR` keeps its existing meaning (force a single
// unnamed personal mount — back-compat with vault_query.ts's vaultDir()) and WINS
// over `$AMICO_VAULTS_ROOT`/`$AMICO_MOUNTS_TOML` when both are set; an explicit
// `vaultsRoot` param still overrides even that.
//
// House style (mirrors repertoire.ts): never-throwing loaders (a missing/corrupt
// vault or manifest degrades to a warning, never a throw) + pure functions.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** One resolved Armonia vault mount. `writable` is the effective posture after the
 *  kind default + any manifest override. */
export interface Mount {
  name: string;
  kind: string;
  path: string; // ABS path to the vault directory
  writable: boolean;
}

/** The ordered mount stack (read precedence top→bottom) plus non-fatal warnings
 *  (skipped/duplicate/corrupt mounts) surfaced for the caller to render. */
export interface MountStack {
  mounts: Mount[];
  warnings: string[];
}

// ── kind ranks + writability (spec canonical order) ──────────────────────────────
const KIND_RANK: Record<string, number> = {
  personal: 0,
  engagement: 1,
  project: 2,
  restricted: 3,
  team: 4,
  public: 5,
};
function kindRank(kind: string): number {
  return kind in KIND_RANK ? KIND_RANK[kind] : 6;
}
const RW_KINDS = new Set(["personal", "engagement", "project"]);
function defaultWritable(kind: string): boolean {
  return RW_KINDS.has(kind);
}

// ── env-seam defaults ─────────────────────────────────────────────────────────
function defaultVaultsRoot(): string {
  const env = process.env.AMICO_VAULTS_ROOT;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "vaults");
}
function defaultMountsToml(): string {
  const env = process.env.AMICO_MOUNTS_TOML;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "mounts.toml");
}

// ── manifest (`mounts.toml`) ─────────────────────────────────────────────────────
interface ManifestEntry {
  id?: string;
  kind?: string;
  path?: string;
  writable?: boolean;
  repo?: string;
}

/** Parse `mounts.toml`'s `[[mount]]` array. Absent → no manifest (no warning);
 *  corrupt → no manifest + a warning (tolerated per house rule). */
function loadManifest(path: string): { entries: ManifestEntry[]; warning?: string } {
  if (!existsSync(path)) return { entries: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { entries: [], warning: `mounts.toml parse error (${path}); ignoring the manifest` };
  }
  const raw = parsed.mount;
  if (!Array.isArray(raw)) return { entries: [] };
  const entries: ManifestEntry[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    entries.push({
      id: typeof e.id === "string" ? e.id : undefined,
      kind: typeof e.kind === "string" && e.kind.trim() !== "" ? e.kind : undefined,
      path: typeof e.path === "string" ? e.path : undefined,
      writable: typeof e.writable === "boolean" ? e.writable : undefined,
      repo: typeof e.repo === "string" ? e.repo : undefined,
    });
  }
  return { entries };
}

/** A discovered mount matches a manifest entry when the mount's resolved name OR
 *  its directory basename equals the entry's id OR its path basename (oracle: id
 *  or path-basename match; hook lines 128–129 / 168–178). */
function entryMatches(name: string, dirBase: string, e: ManifestEntry): boolean {
  const tokens = new Set<string>();
  if (e.id) tokens.add(e.id);
  if (e.path) tokens.add(basename(e.path));
  return tokens.has(name) || tokens.has(dirBase);
}

// ── marker (`.amico-vault.toml`) ─────────────────────────────────────────────────
/** Read a marker's `kind`/`name`. A parse failure is non-fatal: `ok=false` and the
 *  fields come back undefined (the caller may still rescue via the manifest). */
function readMarker(file: string): { ok: boolean; kind?: string; name?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  const scalar = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  return { ok: true, kind: scalar(parsed.kind), name: scalar(parsed.name) };
}

// ── resolver ─────────────────────────────────────────────────────────────────────
/** Resolve the Armonia mount stack. `vaultsRoot`/`mountsTomlPath` default via the
 *  env seam (see header). Never throws. */
export function resolveMountStack(vaultsRoot?: string, mountsTomlPath?: string): MountStack {
  // $AMICO_VAULT_DIR back-compat: force a single unnamed personal mount. Honored
  // only when the caller passed no explicit vaultsRoot (explicit params win); it
  // wins over $AMICO_VAULTS_ROOT / $AMICO_MOUNTS_TOML.
  if (vaultsRoot === undefined) {
    const forced = process.env.AMICO_VAULT_DIR;
    if (forced && forced.trim() !== "") {
      return {
        mounts: [{ name: basename(forced) || forced, kind: "personal", path: forced, writable: true }],
        warnings: [],
      };
    }
  }

  const root = vaultsRoot ?? defaultVaultsRoot();
  const tomlPath = mountsTomlPath ?? defaultMountsToml();
  const warnings: string[] = [];

  if (!existsSync(root)) return { mounts: [], warnings };
  let names: string[];
  try {
    names = readdirSync(root).sort(); // discovery order = dir-name ascending (glob parity)
  } catch {
    return { mounts: [], warnings };
  }

  const manifest = loadManifest(tomlPath);
  if (manifest.warning) warnings.push(manifest.warning);
  const hasManifest = manifest.entries.length > 0;

  // ── discovery (per-mount kind/writable resolution) ──
  const discovered: Mount[] = [];
  const seen = new Set<string>();
  for (const base of names) {
    const dir = join(root, base);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const marker = join(dir, ".amico-vault.toml");
    if (!existsSync(marker)) {
      warnings.push(`skipped ${base}: no .amico-vault.toml marker`);
      continue;
    }
    const m = readMarker(marker);
    if (!m.ok) warnings.push(`${base}: could not parse .amico-vault.toml (treating its fields as empty)`);

    const name = m.name ?? base;
    // Manifest kind override applies BEFORE the missing-kind skip (oracle rescue
    // rule, hook lines 125–133): a kind-less marker with a manifest entry is rescued.
    const entry = manifest.entries.find((e) => entryMatches(name, base, e));
    const kind = entry?.kind ?? m.kind;
    if (!kind) {
      warnings.push(`skipped ${base}: marker missing 'kind' (and no mounts.toml kind)`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`skipped ${base}: duplicate mount id '${name}'`);
      continue;
    }
    seen.add(name);

    let writable = defaultWritable(kind);
    if (entry?.writable === true) writable = true;
    else if (entry?.writable === false) writable = false;

    discovered.push({ name, kind, path: dir, writable });
  }

  // ── ordering ──
  let ordered: Mount[];
  if (hasManifest) {
    // Manifest array order governs; unlisted mounts append in discovery order
    // (oracle parity, hook lines 181–187 — NOT kind-rank).
    ordered = [];
    const emitted = new Set<string>();
    for (const e of manifest.entries) {
      for (const mount of discovered) {
        if (emitted.has(mount.name)) continue;
        if (entryMatches(mount.name, basename(mount.path), e)) {
          ordered.push(mount);
          emitted.add(mount.name);
        }
      }
    }
    for (const mount of discovered) {
      if (!emitted.has(mount.name)) ordered.push(mount);
    }
  } else {
    // No manifest: kind-rank, then name (matches the hook's `sort -k1,1n -k2,2`).
    ordered = [...discovered].sort(
      (a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }

  return { mounts: ordered, warnings };
}

/** The personal mount (the routed writer's default target, the extension's
 *  personalization root) — the first mount of kind `personal`, if any. */
export function personalMount(stack: MountStack): Mount | undefined {
  return stack.mounts.find((m) => m.kind === "personal");
}

/** Read a vault directory's `.amico-vault.toml` marker (kind/name). Amico-run-only
 *  helper (not part of the shared twin API): `vault status` uses the raw marker
 *  kind to detect drift against the manifest-resolved kind. Never throws. */
export function readVaultMarker(vaultDir: string): { kind?: string; name?: string } {
  const m = readMarker(join(vaultDir, ".amico-vault.toml"));
  return { kind: m.kind, name: m.name };
}
