// studio.ts — the studio reader (#402). ONE library owns manifest parsing and
// root resolution; consumers ask, never re-derive. The doctrine: absent
// manifest = the legacy ladder EXACTLY (never brick); malformed = throw
// field-precise so consumers can warn and fall back; env override wins for
// hermetic tests. The manifest names roots, never secrets (keyring stays
// per-machine).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { validateFile } from "./index.js";

/** The manifest shape (schema kind `amicode-config` is the contract — this
 *  interface mirrors it; validate() is the arbiter). */
export interface StudioMountDecl {
  name: string;
  kind: "personal" | "engagement" | "project" | "restricted" | "team" | "public";
  mode: "rw" | "ro";
  path: string;
}

export interface StudioManifest {
  schema_version: string;
  studio_root: string;
  tenant?: string;
  vaults?: { mounts?: StudioMountDecl[] };
  catalog?: string;
  ledger?: string;
  harness?: string;
  packs_external?: string;
  problems?: string;
  runs?: string;
  vaults_root?: string;
}

export interface StudioMount extends StudioMountDecl {
  path: string; // absolute
}

export interface StudioPaths {
  source: "manifest" | "legacy";
  studioRoot: string;
  vaultsRoot: string;
  catalog: string | null; // null in legacy (no studio catalog root exists today)
  ledger: string;
  harness: string;
  packsExternal: string | null;
  problems: string;
  runs: string;
  mounts: StudioMount[];
  tenant: string;
}

export function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Resolve every root from the manifest: explicit overrides win, the rest
 *  derive from studio_root. Mount paths resolve against vaults_root
 *  (default <studio>/vaults); absolute mount paths pass through. Document
 *  order IS precedence. */
export function resolveStudioPaths(m: StudioManifest): StudioPaths {
  const studioRoot = expandTilde(m.studio_root);
  const vaultsRoot = m.vaults_root ? expandTilde(m.vaults_root) : join(studioRoot, "vaults");
  const mounts: StudioMount[] = (m.vaults?.mounts ?? []).map((mo) => ({
    ...mo,
    path: mo.path.startsWith("~") ? expandTilde(mo.path) : mo.path.startsWith("/") ? mo.path : join(vaultsRoot, mo.path),
  }));
  return {
    source: "manifest",
    studioRoot,
    vaultsRoot,
    catalog: m.catalog ? expandTilde(m.catalog) : join(studioRoot, "catalog"),
    ledger: m.ledger ? expandTilde(m.ledger) : join(studioRoot, "ledger"),
    harness: m.harness ? expandTilde(m.harness) : join(studioRoot, "ledger", "harness"),
    packsExternal: m.packs_external ? expandTilde(m.packs_external) : join(studioRoot, "packs"),
    problems: m.problems ? expandTilde(m.problems) : join(studioRoot, "problems"),
    runs: m.runs ? expandTilde(m.runs) : join(studioRoot, "runs"),
    mounts,
    tenant: m.tenant ?? "local",
  };
}

/** Today's ladder, literally: the ~/.amico paths (the transition symlinks
 *  resolve transparently at IO time). Legacy has NO studio catalog root —
 *  doctor flags that drift. */
export function legacyStudioPaths(): StudioPaths {
  const dot = join(homedir(), ".amico");
  return {
    source: "legacy",
    studioRoot: join(homedir(), "armonia"),
    vaultsRoot: join(dot, "vaults"),
    catalog: null,
    ledger: join(dot, "ledger"),
    harness: join(dot, "harness"),
    packsExternal: null,
    problems: join(dot, "problems"),
    runs: join(dot, "runs"),
    mounts: [],
    tenant: "local",
  };
}

/** The discovery ladder: hermetic env override → the canonical dotdir → the
 *  transition dotdir → absent. */
export function studioManifestCandidates(): string[] {
  const env = process.env.AMICODE_STUDIO_CONFIG;
  return [
    ...(env ? [env] : []),
    join(homedir(), ".amicode", "config.toml"),
    join(homedir(), ".amico", "config.toml"),
  ];
}

/** Load the binding: the first manifest that EXISTS wins. Absent everywhere
 *  → null (the caller uses legacyStudioPaths — parity). Malformed → throw
 *  with field-precise errors (the caller warns and falls back — never brick). */
export function loadStudioBinding(explicitFile?: string): { paths: StudioPaths } | null {
  const candidates = explicitFile ? [explicitFile] : studioManifestCandidates();
  let found: string | null = null;
  for (const c of candidates) {
    try {
      readFileSync(c);
      found = c;
      break;
    } catch {
      /* absent — next candidate */
    }
  }
  if (found === null) return null;
  const v = validateFile(found, "amicode-config");
  if (!v.ok) throw new Error(`${found}: invalid studio manifest:\n  ${v.errors.join("\n  ")}`);
  const manifest = parseToml(readFileSync(found, "utf8")) as unknown as StudioManifest;
  return { paths: resolveStudioPaths(manifest) };
}

/** The one consumer-facing call: paths or null; never throws for ABSENCE. */
export function studioPathsOrLegacy(): StudioPaths {
  try {
    return loadStudioBinding()?.paths ?? legacyStudioPaths();
  } catch (e) {
    return legacyStudioPaths();
  }
}
