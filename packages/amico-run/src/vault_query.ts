// The knowledge-graph RETRIEVAL core — the pure logic behind the `amico vault`
// verb (issue #113, slice B3; spec-20260708-112732 §3.1, §7.3). The vault is the
// Amico Obsidian knowledge graph (insights/, experiments/, …) under the mounted
// vaults. The design intent (§7.3) is RETRIEVAL, not front-loading context: a
// query tool an agent calls on demand, ranking notes by relevance to a query
// rather than dumping the whole graph into the prompt.
//
// This mirrors repertoire.ts: a never-throwing loader (a missing/corrupt vault
// degrades to no notes; an unreadable file is skipped, not fatal) + a pure
// ranking function. Frontmatter parsing is intentionally MINIMAL — the handful
// of scalar fields the ranker/filters need (type/platform/gate/tags), extracted
// by regex, not a full YAML engine.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A vault note projected for retrieval. `body` is the markdown after the
 *  frontmatter; `title` is the first `# ` heading (else the filename). */
export interface NoteRecord {
  path: string; // ABS path
  file: string; // basename
  folder: string; // "insights" | "experiments" | …
  type?: string; // frontmatter `type`
  title: string;
  platform?: string;
  gate?: string;
  tags: string[];
  body: string;
}

/** The vault root. `$AMICO_VAULT_DIR` overrides it (tests point it at a temp
 *  dir); default is the company (team) vault mount. Returns the path
 *  unconditionally — loadNotes handles a missing mount by returning []. */
export function vaultDir(): string {
  const env = process.env.AMICO_VAULT_DIR;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "vaults", "armonissima");
}

/** The note folders the retrieval searches — the knowledge-graph nucleus
 *  (spec §3.1: insights/experiments). */
export const NOTE_FOLDERS = ["insights", "experiments"] as const;

// ── frontmatter (minimal, regex-based — NOT a general YAML parser) ────────────

interface Frontmatter {
  type?: string;
  platform?: string;
  gate?: string;
  tags: string[];
}

function splitFrontmatter(text: string): { fm: string; body: string } {
  // A note begins with `---\n … \n---\n`. Anything else → no frontmatter.
  if (!text.startsWith("---")) return { fm: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: "", body: text };
  const fm = text.slice(text.indexOf("\n") + 1, end);
  const rest = text.slice(end + 4); // past "\n---"
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;
  return { fm, body };
}

function scalar(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return undefined;
  const raw = m[1].trim();
  if (raw === "" || raw === "null" || raw === "~") return undefined;
  return raw.replace(/^["']|["']$/g, ""); // strip surrounding quotes
}

function parseTags(fm: string): string[] {
  // `tags: [a, b, gate/X]` — the inline-list form the vault uses.
  const m = fm.match(/^tags:\s*\[(.*)\]/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(fm: string): Frontmatter {
  return {
    type: scalar(fm, "type"),
    platform: scalar(fm, "platform"),
    gate: scalar(fm, "gate"),
    tags: parseTags(fm),
  };
}

function titleOf(body: string, file: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : file.replace(/\.md$/, "");
}

function parseNote(path: string, file: string, folder: string): NoteRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const { fm, body } = splitFrontmatter(text);
  const meta = parseFrontmatter(fm);
  return {
    path,
    file,
    folder,
    type: meta.type,
    title: titleOf(body, file),
    platform: meta.platform,
    gate: meta.gate,
    tags: meta.tags,
    body,
  };
}

/** Scan the note folders under `dir` into records. Never throws. */
export function loadNotes(dir: string, folders: readonly string[] = NOTE_FOLDERS): NoteRecord[] {
  const records: NoteRecord[] = [];
  for (const folder of folders) {
    const folderDir = join(dir, folder);
    if (!existsSync(folderDir)) continue;
    let names: string[];
    try {
      names = readdirSync(folderDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const rec = parseNote(join(folderDir, name), name, folder);
      if (rec) records.push(rec);
    }
  }
  return records;
}

// ── relevance ranking ─────────────────────────────────────────────────────────

export interface RankedNote {
  path: string;
  file: string;
  folder: string;
  type?: string;
  title: string;
  tags: string[];
  score: number;
  snippet: string;
}

export interface QueryOpts {
  type?: string; // filter: only notes with this frontmatter `type`
  platform?: string; // filter: only notes with this platform
  gate?: string; // filter: only notes with this gate
  limit?: number; // top-N (default 10)
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Weighted term-frequency score: a title hit is worth the most, a tag hit next,
 *  a body hit least. Deterministic; ties break by path. */
function scoreNote(note: NoteRecord, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = note.title.toLowerCase();
  const tagBlob = note.tags.join(" ").toLowerCase();
  const body = note.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (tagBlob.includes(term)) score += 3;
    const bodyHits = countOccurrences(body, term);
    score += Math.min(bodyHits, 5); // cap body weight so a term-spamming note can't dominate
  }
  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/** A short context snippet: the first body line containing any query term, else
 *  the note's first non-empty prose line. */
function snippetFor(note: NoteRecord, terms: string[]): string {
  const lines = note.body.split("\n").map((l) => l.trim());
  const prose = lines.filter((l) => l && !l.startsWith("#") && !l.startsWith("---"));
  const hit = prose.find((l) => terms.some((t) => l.toLowerCase().includes(t)));
  const line = hit ?? prose[0] ?? "";
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}

export function rankNotes(notes: NoteRecord[], query: string, opts: QueryOpts = {}): RankedNote[] {
  const terms = tokenize(query);
  const filtered = notes.filter(
    (n) =>
      (opts.type === undefined || n.type === opts.type) &&
      (opts.platform === undefined || n.platform === opts.platform) &&
      (opts.gate === undefined || n.gate === opts.gate),
  );
  const scored = filtered.map((n) => ({ note: n, score: scoreNote(n, terms) }));
  scored.sort((a, b) => b.score - a.score || (a.note.path < b.note.path ? -1 : a.note.path > b.note.path ? 1 : 0));
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 10;
  return scored
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map(({ note, score }) => ({
      path: note.path,
      file: note.file,
      folder: note.folder,
      type: note.type,
      title: note.title,
      tags: note.tags,
      score,
      snippet: snippetFor(note, terms),
    }));
}
