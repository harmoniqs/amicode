import { discover } from "./discover.js";
import { parseClaudeFile } from "./parse_claude.js";
import { parseCodexFile } from "./parse_codex.js";
import { importExportData } from "./import_opencode.js";

function parseArgs(argv: string[]): {
  command: string;
  sources: string[];
  dryRun: boolean;
  db?: string;
  opencode?: string;
  limit?: number;
  includeArchived: boolean;
  json: boolean;
} {
  let command = "preview";
  const sources: string[] = [];
  let dryRun = false;
  let db: string | undefined;
  let opencode: string | undefined;
  let limit: number | undefined;
  let includeArchived = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "preview") command = "preview";
    else if (a === "import" || a === "run") command = "import";
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--include-archived") includeArchived = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--db=")) db = a.slice("--db=".length);
    else if (a === "--db" && argv[i + 1]) db = argv[++i];
    else if (a.startsWith("--opencode=")) opencode = a.slice("--opencode=".length);
    else if (a === "--opencode" && argv[i + 1]) opencode = argv[++i];
    else if (a.startsWith("--source=")) sources.push(...a.slice("--source=".length).split(",").filter(Boolean));
    else if (a === "--source" && argv[i + 1]) sources.push(...argv[++i].split(",").filter(Boolean));
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") command = "help";
  }

  if (sources.length === 0) sources.push("claude", "codex");
  return { command, sources: sources.map((s) => s.toLowerCase()), dryRun, db, opencode, limit, includeArchived, json };
}

function usage(): string {
  return `usage:
  amico sessions preview [--source claude,codex,opencode] [--db <path>] [--include-archived] [--limit N] [--json]
  amico sessions import  [--source claude,codex] [--opencode <binary>] [--db <path>] [--include-archived] [--dry-run] [--limit N] [--json]
    --source    comma list (default: claude,codex)
    --opencode  path to the vendored opencode binary (default: OPENCODE_BINARY or \`opencode\` on PATH)
    --db        opencode DB path (default: OPENCODE_DB or ~/.local/share/opencode/opencode.db)
    --include-archived  include ~/.codex/archived_sessions
    --dry-run   parse + validate without writing
    --limit     cap sessions per source (for throwaway DB testing)
`;
}

export async function sessionsVerb(argv: string[]): Promise<{ json: unknown; code: number }> {
  const opts = parseArgs(argv);
  if (opts.command === "help") return { json: { usage: usage() }, code: 0 };

  const discovery = discover({ opencodeDb: opts.db });

  const wantClaude = opts.sources.includes("claude") || opts.sources.includes("all");
  const wantCodex = opts.sources.includes("codex") || opts.sources.includes("all");
  const wantOpencode = opts.sources.includes("opencode") || opts.sources.includes("all");

  let claudeSessions = wantClaude ? discovery.claude : [];
  let codexSessions = wantCodex ? discovery.codex : [];
  if (!opts.includeArchived) codexSessions = codexSessions.filter((s) => !s.path.includes("archived_sessions"));

  if (opts.limit !== undefined && !Number.isNaN(opts.limit)) {
    claudeSessions = claudeSessions.slice(0, opts.limit);
    codexSessions = codexSessions.slice(0, opts.limit);
  }

  if (opts.command === "preview") {
    const preview = {
      warnings: discovery.warnings,
      isDevcontainer: discovery.isDevcontainer,
      sources: {
        claude: { count: claudeSessions.length, sample: claudeSessions.slice(0, 3).map((s) => ({ id: s.id, title: s.title, path: s.path, bytes: s.bytes })) },
        codex: { count: codexSessions.length, sample: codexSessions.slice(0, 3).map((s) => ({ id: s.id, title: s.title, path: s.path, bytes: s.bytes })) },
        opencode: wantOpencode ? { count: discovery.opencode.length } : undefined,
      },
      total: claudeSessions.length + codexSessions.length,
    };
    return { json: preview, code: 0 };
  }

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ id: string; source: string; title: string; created: boolean; messages: number; parts: number; error?: string }> = [];

  const all = [
    ...claudeSessions.map((s) => ({ ...s, _source: "claude" as const })),
    ...codexSessions.map((s) => ({ ...s, _source: "codex" as const })),
  ];

  for (const s of all) {
    let data;
    try {
      data = s._source === "claude" ? parseClaudeFile(s.path, s.directory) : parseCodexFile(s.path, s.directory);
    } catch (e) {
      failed++;
      details.push({ id: s.id, source: s._source, title: s.title, created: false, messages: 0, parts: 0, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!data) {
      skipped++;
      details.push({ id: s.id, source: s._source, title: s.title, created: false, messages: 0, parts: 0, error: "no messages (empty or filtered)" });
      continue;
    }
    if (opts.dryRun) {
      imported++;
      details.push({ id: data.info.id, source: s._source, title: data.info.title, created: true, messages: data.messages.length, parts: data.messages.reduce((n, m) => n + m.parts.length, 0) });
      continue;
    }
    try {
      const res = importExportData({ data, opencode: opts.opencode, dbPath: opts.db });
      imported++;
      details.push({ id: res.sessionId, source: s._source, title: data.info.title, created: res.created, messages: res.messages, parts: res.parts });
    } catch (e) {
      failed++;
      details.push({ id: s.id, source: s._source, title: s.title, created: false, messages: 0, parts: 0, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  }

  return {
    json: {
      rekey: "always (opencode import re-keys projectID/directory/path to cwd; original in metadata.original_directory)",
      warnings: discovery.warnings,
      summary: { scanned: all.length, imported, skipped, failed },
      details: opts.json ? details : details.slice(0, 20),
      truncated: details.length > 20 && !opts.json ? `showing 20/${details.length} — add --json for all` : undefined,
    },
    code: failed > 0 ? 1 : 0,
  };
}
