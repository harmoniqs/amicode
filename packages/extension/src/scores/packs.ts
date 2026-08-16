// Pack loader (autoresearch studio WS1, #369) — a pack is the unit of
// generality: one manifest per domain, the score a FIELD of the pack. Packs
// resolve from an ordered root list (precedence top→bottom, the mount-stack
// grammar): the bundled packs dir first, an external root appended later as
// the second-pack seam (WS3). The manifest is validated through the ONE
// shared validator (@amicode/schema kind "pack"); score dirs load through the
// existing parseScoreMd so a pack's scores are byte-identical Score objects.
// A broken pack is REPORTED, never thrown — pack trouble must not brick the
// boot (the same isolation property loadRepertoire carries).
import * as fs from "node:fs";
import * as path from "node:path";
import { validateFile } from "@amicode/schema";
import { parse as parseToml } from "smol-toml";
import { parseScoreMd, Score } from "./loader";

/** The pack manifest shape (schema package kind "pack" is the contract —
 *  this interface mirrors it for typed consumers; validate() is the arbiter). */
export interface PackManifest {
  schema_version: string;
  id: string;
  name: string;
  version?: number;
  scores: string[];
  onboarding: { primary: string; head?: string };
  skills?: { path: string; tier?: string }[];
  templates?: Record<string, { path: string; tier?: string }>;
  corrector: { name: string; paths: string[]; integrity: string; tier?: string };
  catalog_schema?: string;
  eval_corpus?: string;
}

export interface Pack {
  manifest: PackManifest;
  dir: string;
  scores: Score[];
}

export interface PacksLoad {
  packs: Pack[];
  errors: { path: string; errors: string[] }[];
}

const MANIFEST = "PACK.toml";

/** Load every pack found under the ordered roots. Roots are scanned in
 *  precedence order (earlier root shadows later on id collision); each dir
 *  carrying a PACK.toml is a pack; everything else is skipped silently. */
export function loadPacks(roots: string[]): PacksLoad {
  const out: PacksLoad = { packs: [], errors: [] };
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const manifestPath = path.join(dir, MANIFEST);
      if (!fs.existsSync(manifestPath)) continue;
      let manifest: PackManifest;
      try {
        manifest = parsePackManifest(manifestPath);
      } catch (e) {
        out.errors.push({ path: manifestPath, errors: [String(e)] });
        continue;
      }
      if (seen.has(manifest.id)) continue; // higher-precedence root shadows
      seen.add(manifest.id);
      // Scores are loaded eagerly: a pack with an unparseable score is a
      // BROKEN pack (reported whole), keeping the all-or-nothing contract a
      // consumer's boot fallback expects.
      const scores: Score[] = [];
      const scoreErrs: string[] = [];
      for (const rel of manifest.scores) {
        const scoreDir = path.resolve(dir, rel);
        const scorePath = path.join(scoreDir, "SCORE.md");
        try {
          const { manifest: m, body } = parseScoreMd(fs.readFileSync(scorePath, "utf8"), scorePath);
          scores.push({ manifest: m, body, dir: scoreDir });
        } catch (e) {
          scoreErrs.push(String(e));
        }
      }
      if (scoreErrs.length) {
        out.errors.push({ path: manifestPath, errors: scoreErrs });
        continue;
      }
      out.packs.push({ manifest, dir, scores });
    }
  }
  return out;
}

/** Read + validate a PACK.toml through the ONE shared validator (the schema
 *  package's file path: read → parse → field-precise errors), then parse the
 *  value for typed consumers. */
export function parsePackManifest(manifestPath: string): PackManifest {
  const v = validateFile(manifestPath, "pack");
  if (!v.ok) throw new Error(`${manifestPath}: invalid pack manifest:\n  ${v.errors.join("\n  ")}`);
  return parseToml(fs.readFileSync(manifestPath, "utf8")) as unknown as PackManifest;
}
