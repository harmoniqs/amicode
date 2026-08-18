// papers.ts — the unified literature corpus fold (#405): one read-only view
// over vault papers/ notes + the library PDF store. Collected, unified,
// deduped by identity (REPORTED, never merged — merging is a human promote
// act), content-addressed join (sha256 on read; filenames stay human),
// orphans surfaced both directions. The fold never writes.
//
// Zero-dep note: vault note frontmatter is a YAML subset (flat scalars,
// quoted strings, inline lists, null) — a ~50-line reader beats a dependency
// (the runstatus.ts TOML-subset precedent, invariant 7). If a note needs
// richer YAML, widen the subset with a test, not a library.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { validate, studioPathsOrLegacy } from "@amicode/schema";
import type { StudioPaths } from "@amicode/schema";

/** Parse a note's --- frontmatter fence (flat YAML subset). Throws on a
 *  missing fence; unknown value shapes land as strings. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error("missing --- frontmatter block");
  const out: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) throw new Error(`unparseable frontmatter line: ${line}`);
    const [, key, raw] = kv;
    out[key] = parseValue(raw!.trim());
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw;
}

export interface PaperRecord {
  file: string;
  title: string;
  authors: string[];
  arxiv?: string;
  doi?: string;
  status: "staged" | "distilled"; // absent frontmatter = distilled (historical)
  tags: string[];
  systems: string[];
  relevance?: string;
  frontmatter: Record<string, unknown>;
  pdf?: { file: string; sha256: string };
}

export interface CorpusReport {
  papers: PaperRecord[];
  /** same identity seen in multiple notes — reported, never merged */
  duplicates: { key: string; files: string[] }[];
  /** notes whose frontmatter fails the library-paper contract */
  invalid: { file: string; errors: string[] }[];
  /** library PDFs no record claims */
  orphanPdfs: { file: string; sha256: string }[];
  /** records with no PDF in the library (the acquisition to-do list) */
  recordsWithoutPdf: { file: string; title: string; arxiv?: string; doi?: string }[];
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** arxiv "1711.09641v2" → "1711.09641" — version suffixes normalize at the
 *  fold (the schema stays strict on the canonical form). */
function normalizeArxiv(id: string): string {
  return id.replace(/v\d+$/, "");
}

/** Fold the corpus: every <vaults-root>/<mount>/papers/*.md note, validated,
 *  unified, joined against the library's PDFs. Read-only; absence degrades
 *  to empty everywhere. */
export function foldCorpus(vaultRoots: string[], libraryRoot: string): CorpusReport {
  const report: CorpusReport = { papers: [], duplicates: [], invalid: [], orphanPdfs: [], recordsWithoutPdf: [] };

  // 1. collect + validate notes across every mount of every root
  const byIdentity = new Map<string, PaperRecord[]>();
  for (const root of vaultRoots) {
    if (!existsSync(root)) continue;
    let mounts: string[] = [];
    try {
      mounts = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(root, d.name));
    } catch {
      continue;
    }
    for (const mount of mounts) {
      const papersDir = join(mount, "papers");
      if (!existsSync(papersDir)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(papersDir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.startsWith("MERGED-INTO-")) continue; // merge tombstones are retired records
        const file = join(papersDir, f);
        let fm: Record<string, unknown>;
        try {
          fm = parseFrontmatter(readFileSync(file, "utf8"));
        } catch (e) {
          report.invalid.push({ file, errors: [String(e)] });
          continue;
        }
        const v = validate(fm, "library-paper");
        if (!v.ok) {
          report.invalid.push({ file, errors: v.errors });
          continue;
        }
        const rec: PaperRecord = {
          file,
          title: fm.title as string,
          authors: fm.authors as string[],
          arxiv: fm.arxiv ? normalizeArxiv(fm.arxiv as string) : undefined,
          doi: fm.doi as string | undefined,
          status: (fm.status as "staged" | "distilled") ?? "distilled",
          tags: (fm.tags as string[]) ?? [],
          systems: (fm.systems as string[]) ?? [],
          relevance: fm.relevance as string | undefined,
          frontmatter: fm,
        };
        report.papers.push(rec);
        const key = rec.arxiv ? `arxiv:${rec.arxiv}` : rec.doi ? `doi:${rec.doi}` : null;
        if (key) {
          const bucket = byIdentity.get(key) ?? [];
          bucket.push(rec);
          byIdentity.set(key, bucket);
        }
      }
    }
  }
  for (const [key, bucket] of byIdentity)
    if (bucket.length > 1) report.duplicates.push({ key, files: bucket.map((b) => b.file) });

  // 2. library PDFs: content-addressed, identity-joined by filename
  const pdfs: { file: string; sha256: string }[] = [];
  if (existsSync(libraryRoot)) {
    try {
      for (const f of readdirSync(libraryRoot)) {
        const file = join(libraryRoot, f);
        try {
          if (!statSync(file).isFile()) continue;
          pdfs.push({ file, sha256: sha256(readFileSync(file)) });
        } catch {
          /* unreadable file — skip */
        }
      }
    } catch {
      /* unreadable root — no pdfs */
    }
  }
  const claimed = new Set<string>();
  for (const p of report.papers) {
    const match = p.arxiv
      ? pdfs.find((x) => basenameContainsIdentity(x.file, p.arxiv!))
      : p.doi
        ? pdfs.find((x) => x.file.includes(sanitizeDoi(p.doi!)))
        : undefined;
    if (match) {
      p.pdf = { file: match.file, sha256: match.sha256 };
      claimed.add(match.file);
    } else {
      report.recordsWithoutPdf.push({ file: p.file, title: p.title, arxiv: p.arxiv, doi: p.doi });
    }
  }
  report.orphanPdfs = pdfs.filter((x) => !claimed.has(x.file));
  return report;
}

function basenameContainsIdentity(file: string, arxivId: string): boolean {
  const base = file.replace(/^.*[\\/]/, "");
  // boundary-safe: "1711.09641.pdf", "1711.09641v2.pdf", "arXiv-1711.09641(1).pdf"
  const re = new RegExp(`(^|[^0-9])${escapeRe(arxivId)}(v\\d+)?([^0-9]|$)`);
  return re.test(base);
}

function sanitizeDoi(doi: string): string {
  return escapeRe(doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, ""));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The corpus over THIS machine's studio ladder (manifest → legacy). The
 *  library root stays the legacy ~/.amico/library until the manifest grows a
 *  library field (v2 — the installation spec keeps PDFs as library state). */
export function foldStudioCorpus(paths?: StudioPaths): CorpusReport {
  const p = paths ?? studioPathsOrLegacy();
  return foldCorpus([p.vaultsRoot], join(homedir(), ".amico", "library"));
}
