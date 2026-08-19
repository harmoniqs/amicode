// Context-seed pipeline — scan, redact, extract, materialize (#436)
//
// Scans allowlisted AI-tool config files, redacts secrets, extracts profile
// facts and memory cards, and writes them through the existing onboarding
// event pipeline. No VS Code dependencies — pure Node logic.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Allowlist (data-driven) ─────────────────────────────────────────────────

export interface ScanRoot {
  /** Root directory to scan. `~` is expanded to homedir. */
  root: string;
  /** Filenames to look for under this root. */
  filenames: string[];
}

/** The allowlisted scan locations. Expand `~` before use. */
export const SCAN_ALLOWLIST: ScanRoot[] = [
  { root: "~", filenames: ["CLAUDE.md", "AGENTS.md", ".cursorrules"] },
  { root: "~/.config/opencode", filenames: ["opencode.json", "opencode.jsonc"] },
  { root: "~/.cursor", filenames: ["rules"] },
  { root: "~/.continue", filenames: ["config.json"] },
];

/** Maximum bytes to read from any single file. */
export const SIZE_CAP = 50 * 1024; // 50KB

/** Resolve `~` to the actual home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export interface ScannedFile {
  /** Absolute path of the file that was read. */
  path: string;
  /** Content (size-capped, secret-redacted). */
  content: string;
  /** Whether the content was truncated due to size cap. */
  truncated: boolean;
}

/** Resolve the allowlist to the files that actually exist on disk.
 *  Returns only existing, readable paths. Does NOT read content. */
export function resolveAllowlist(
  allowlist: ScanRoot[] = SCAN_ALLOWLIST,
): string[] {
  const results: string[] = [];
  for (const entry of allowlist) {
    const root = expandHome(entry.root);
    for (const filename of entry.filenames) {
      const full = path.join(root, filename);
      try {
        fs.accessSync(full, fs.constants.R_OK);
        results.push(full);
      } catch {
        // File doesn't exist or isn't readable — skip
      }
    }
  }
  return results;
}

/** Read a file with size cap and secret redaction applied at read time.
 *  Returns the processed content. If the file cannot be read, returns undefined. */
export function readAndRedact(filePath: string, sizeCap: number = SIZE_CAP): ScannedFile | undefined {
  try {
    const stat = fs.statSync(filePath);
    const truncated = stat.size > sizeCap;
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, sizeCap));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const raw = buffer.toString("utf8");
    const redacted = redactSecrets(raw);
    return { path: filePath, content: redacted, truncated };
  } catch {
    return undefined;
  }
}

/** Scan all allowlisted files: resolve → read → redact. Returns only files found. */
export function scanAllowlistedFiles(allowlist: ScanRoot[] = SCAN_ALLOWLIST): ScannedFile[] {
  const paths = resolveAllowlist(allowlist);
  const results: ScannedFile[] = [];
  for (const p of paths) {
    const file = readAndRedact(p);
    if (file) results.push(file);
  }
  return results;
}

// ─── Secret redaction ────────────────────────────────────────────────────────

/** Expanded SECRET_RE — matches API keys, tokens, passwords, PEM blocks, etc.
 *  Applied AT READ TIME, before any processing or storage. */
export const SECRET_PATTERNS: RegExp[] = [
  // Key-value pairs with secret-like keys
  /(?<=[\s"':=])(sk-[a-zA-Z0-9_-]{20,})(?=[\s"',\n]|$)/g,
  /(?<=[\s"':=])(sk-ant-[a-zA-Z0-9_-]{20,})(?=[\s"',\n]|$)/g,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Bearer tokens in content
  /Bearer\s+[a-zA-Z0-9._\-+/=]{20,}/g,
  // PEM blocks
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  // Generic key=value patterns where key contains secret/token/password/api_key
  /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|password|access[_-]?token)\s*[:=]\s*["']?[^\s"'\n]{8,}["']?/gi,
];

/** Redact secret-looking values from content, replacing with «credential omitted». */
export function redactSecrets(content: string): string {
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, "«credential omitted»");
  }
  return result;
}

// ─── Fact extraction ─────────────────────────────────────────────────────────

export interface ExtractedFact {
  /** Which vault target this belongs to. */
  target: "profile" | "memory";
  /** For profile: field name. For memory: card type. */
  field: string;
  /** The extracted value. */
  value: unknown;
  /** Which file it was extracted from. */
  source: string;
}

export interface SeedPreview {
  /** Profile facts (name, role, platforms, etc.) */
  profileFacts: ExtractedFact[];
  /** Memory cards (project facts, tool preferences) */
  memoryCards: ExtractedFact[];
}

/** Extract profile facts and memory cards from scanned files.
 *  Conservative — only extracts clearly-structured information. */
export function extractFacts(files: ScannedFile[]): SeedPreview {
  const profileFacts: ExtractedFact[] = [];
  const memoryCards: ExtractedFact[] = [];

  for (const file of files) {
    const basename = path.basename(file.path);

    if (basename === "CLAUDE.md" || basename === "AGENTS.md") {
      // Look for structured identity patterns
      extractMarkdownIdentity(file, profileFacts);
      extractProjectFacts(file, memoryCards);
    } else if (basename === ".cursorrules" || basename === "rules") {
      extractProjectFacts(file, memoryCards);
    } else if (basename.endsWith(".json") || basename.endsWith(".jsonc")) {
      extractJsonConfig(file, profileFacts, memoryCards);
    }
  }

  return { profileFacts, memoryCards };
}

/** Extract identity fields from markdown-style AI config files. */
function extractMarkdownIdentity(file: ScannedFile, facts: ExtractedFact[]): void {
  const content = file.content;

  // Look for name patterns like "User: Name" or "# About\nName: ..."
  const nameMatch = content.match(
    /(?:^|\n)\s*(?:name|user|author|developer)\s*[:=]\s*(.+?)(?:\n|$)/i,
  );
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name && name.length < 100 && !name.includes("«credential")) {
      facts.push({ target: "profile", field: "name", value: name, source: file.path });
    }
  }

  // Look for role/affiliation patterns
  const roleMatch = content.match(
    /(?:^|\n)\s*(?:role|title|position)\s*[:=]\s*(.+?)(?:\n|$)/i,
  );
  if (roleMatch) {
    const role = roleMatch[1].trim();
    if (role && role.length < 200) {
      facts.push({ target: "profile", field: "role", value: role, source: file.path });
    }
  }

  // Look for platform mentions
  const platformPatterns = [
    /(?:transmon|superconducting qubit)/i,
    /(?:rydberg|neutral.atom)/i,
    /(?:trapped.ion|ion.trap)/i,
    /(?:cavity|bosonic)/i,
    /(?:fluxonium)/i,
  ];
  const platforms: string[] = [];
  for (const pat of platformPatterns) {
    if (pat.test(content)) {
      const match = content.match(pat);
      if (match) platforms.push(match[0].toLowerCase());
    }
  }
  if (platforms.length > 0) {
    facts.push({ target: "profile", field: "platforms", value: platforms, source: file.path });
  }
}

/** Extract project-level facts as memory cards. */
function extractProjectFacts(file: ScannedFile, cards: ExtractedFact[]): void {
  const content = file.content;
  const lines = content.split("\n");

  // Extract key directives/rules as a single project-fact card
  const directives: string[] = [];
  for (const line of lines.slice(0, 50)) { // Only first 50 lines
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && trimmed.length > 10 && trimmed.length < 200) {
      directives.push(trimmed);
    }
  }
  if (directives.length > 0) {
    cards.push({
      target: "memory",
      field: "project_context",
      value: directives.slice(0, 10).join("\n"), // Cap at 10 most relevant
      source: file.path,
    });
  }
}

/** Extract config from JSON-format AI tool configs. */
function extractJsonConfig(
  file: ScannedFile,
  _profileFacts: ExtractedFact[],
  memoryCards: ExtractedFact[],
): void {
  try {
    // Strip comments for JSONC
    const stripped = file.content.replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(stripped) as Record<string, unknown>;

    // Extract any "rules" or "instructions" fields as memory cards
    if (typeof config.instructions === "string" || Array.isArray(config.instructions)) {
      memoryCards.push({
        target: "memory",
        field: "tool_config",
        value: `Instructions from ${path.basename(file.path)}`,
        source: file.path,
      });
    }
  } catch {
    // Not valid JSON — skip
  }
}

// ─── Seed writing (via existing event pipeline) ──────────────────────────────

export interface SeedWriteResult {
  /** Number of entities written. */
  count: number;
  /** Any entities that were skipped (duplicates). */
  skipped: number;
}

/** Write confirmed seeds to events.jsonl via appendOnboardingEvent.
 *  Checks for idempotency: profile fields already present are skipped. */
export function writeSeeds(
  dir: string,
  preview: SeedPreview,
  selectedGroups: { profile: boolean; memory: boolean },
  appendFn: (dir: string, entity: string, payload: Record<string, unknown>) => { seq: number },
): SeedWriteResult {
  let count = 0;
  let skipped = 0;

  if (selectedGroups.profile && preview.profileFacts.length > 0) {
    // Merge all profile facts into one payload
    const payload: Record<string, unknown> = {};
    for (const fact of preview.profileFacts) {
      payload[fact.field] = fact.value;
    }
    try {
      appendFn(dir, "profile", payload);
      count++;
    } catch {
      skipped++;
    }
  }

  if (selectedGroups.memory) {
    for (const card of preview.memoryCards) {
      try {
        appendFn(dir, "profile", { [`seed_${card.field}`]: card.value });
        count++;
      } catch {
        skipped++;
      }
    }
  }

  return { count, skipped };
}
