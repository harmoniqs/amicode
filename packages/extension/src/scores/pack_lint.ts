// The pack lint (plan-20260920 step 10; amicode #1328) — "seeded" means
// something. The loader (packs.ts) loads and reports; the LINT is the bar the
// acceptance reads: schema validation PLUS reference resolution PLUS the
// domain key set. A pack counts as SEEDED when its manifest validates, every
// path-bearing reference resolves, and it carries the full domain keys
// (curricula, payload schemas, verification contract with claim-class
// bindings, instruments, benchmarks, first task). The flagship quantum pack
// carries no first task by design — it reads FORMALIZED, not seeded (the
// grandfathered status, spec-20260920 D2/D7).
//
// A manifest is cheap; a domain is not (the r3 advisory, verbatim): the
// exercised bar — the first task run end-to-end through the campaign loop
// with a tier-labeled verdict — is a run state, never a manifest state; the
// lint records the declared level (shakedown | substrate) and stops there,
// honestly.
import * as fs from "node:fs";
import * as path from "node:path";
import { validateFile } from "@amicode/schema";
import { parse as parseToml } from "smol-toml";

export interface PackLintFinding {
  kind: "schema" | "dangling-ref" | "missing-domain-key";
  detail: string;
}

export interface PackLintResult {
  dir: string;
  id: string;
  seeded: boolean;
  exerciseLevel: "shakedown" | "substrate" | undefined;
  findings: PackLintFinding[];
}

/** The domain key set — required for SEEDED, optional at the schema layer so
 *  the flagship's WS1 manifest stays valid without them. */
export const DOMAIN_KEYS = [
  "curricula",
  "payload_schemas",
  "verification",
  "instruments",
  "benchmarks",
  "first_task",
] as const;

interface PathBearing {
  field: string
  p: string
}

function collectReferences(manifest: Record<string, unknown>): PathBearing[] {
  const refs: PathBearing[] = []
  const rel = (field: string, v: unknown) => {
    if (typeof v === "string") refs.push({ field, p: v })
  }
  for (const s of (manifest["scores"] as string[]) ?? []) rel("scores", s)
  for (const sk of (manifest["skills"] as { path: string }[]) ?? []) rel("skills", sk.path)
  const templates = manifest["templates"] as Record<string, { path: string }> | undefined
  if (templates) for (const t of Object.values(templates)) rel("templates", t.path)
  const corrector = manifest["corrector"] as { paths: string[]; integrity: string } | undefined
  if (corrector) {
    for (const c of corrector.paths ?? []) rel("corrector.paths", c)
    rel("corrector.integrity", corrector.integrity)
  }
  for (const c of (manifest["curricula"] as string[]) ?? []) rel("curricula", c)
  for (const c of (manifest["payload_schemas"] as string[]) ?? []) rel("payload_schemas", c)
  for (const b of (manifest["benchmarks"] as string[]) ?? []) rel("benchmarks", b)
  const verification = manifest["verification"] as { contract: string } | undefined
  if (verification) rel("verification.contract", verification.contract)
  const firstTask = manifest["first_task"] as { declaration: string } | undefined
  if (firstTask) rel("first_task.declaration", firstTask.declaration)
  return refs
}

/** Lint one pack dir. Never throws: findings are the interface. */
export function lintPackDir(dir: string): PackLintResult {
  const manifestPath = path.join(dir, "PACK.toml")
  const findings: PackLintFinding[] = []

  if (!fs.existsSync(manifestPath)) {
    return { dir, id: "<no manifest>", seeded: false, exerciseLevel: undefined, findings: [{ kind: "schema", detail: "no PACK.toml" }] }
  }

  const validation = validateFile(manifestPath, "pack")
  if (!validation.ok) {
    findings.push({ kind: "schema", detail: validation.errors.join("; ") })
  }

  let manifest: Record<string, unknown> = {}
  try {
    manifest = parseToml(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  } catch (e) {
    findings.push({ kind: "schema", detail: `unparsable TOML: ${e instanceof Error ? e.message : String(e)}` })
    return { dir, id: "<unparsable>", seeded: false, exerciseLevel: undefined, findings }
  }

  // Reference resolution: every path-bearing field resolves, dangling = named.
  for (const { field, p } of collectReferences(manifest)) {
    const resolved = path.resolve(dir, p)
    if (!fs.existsSync(resolved)) {
      findings.push({ kind: "dangling-ref", detail: `${field}: ${p} does not resolve (${resolved})` })
    }
  }

  // The seeded check: full domain key set AND a clean manifest.
  for (const key of DOMAIN_KEYS) {
    if (!(key in manifest)) {
      findings.push({ kind: "missing-domain-key", detail: `${key} absent — not a seeded domain pack (formalized/legacy packs omit it by design)` })
    }
  }
  const exerciseLevel = (manifest["first_task"] as { level?: "shakedown" | "substrate" } | undefined)?.level

  return {
    dir,
    id: String(manifest["id"] ?? "<no id>"),
    seeded: findings.length === 0,
    exerciseLevel,
    findings,
  }
}

/** Lint every pack under the ordered roots — the acceptance's validator. */
export function lintPacks(roots: string[]): PackLintResult[] {
  const results: PackLintResult[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      if (fs.existsSync(path.join(dir, "PACK.toml"))) results.push(lintPackDir(dir))
    }
  }
  return results
}
