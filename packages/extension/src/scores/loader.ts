import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { ScoreManifest, validateScoreManifest } from "./schema";

export interface Score {
  manifest: ScoreManifest;
  body: string;
  dir: string;
}

export interface RepertoireLoad {
  scores: Score[];
  errors: { path: string; errors: string[] }[];
}

export function parseScoreMd(content: string, sourcePath = "<inline>"): { manifest: ScoreManifest; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${sourcePath}: missing --- frontmatter block`);
  const manifest = parseYaml(m[1]) as ScoreManifest;
  const errs = validateScoreManifest(manifest);
  if (errs.length) throw new Error(`${sourcePath}: invalid score manifest:\n  ${errs.join("\n  ")}`);
  return { manifest, body: m[2] ?? "" };
}

// A broken score must never take down the repertoire — it is reported, not thrown.
export function loadRepertoire(root: string): RepertoireLoad {
  const out: RepertoireLoad = { scores: [], errors: [] };
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "memory") continue;
    const scorePath = path.join(root, entry.name, "SCORE.md");
    if (!fs.existsSync(scorePath)) continue;
    try {
      const { manifest, body } = parseScoreMd(fs.readFileSync(scorePath, "utf8"), scorePath);
      out.scores.push({ manifest, body, dir: path.join(root, entry.name) });
    } catch (e) {
      out.errors.push({ path: scorePath, errors: [String(e)] });
    }
  }
  return out;
}
