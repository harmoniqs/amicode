import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface SourceSession {
  id: string;
  title: string;
  directory: string;
  source: "claude" | "codex" | "opencode";
  path: string;
  bytes: number;
  time: number;
  messageCount?: number;
}

export interface Discovery {
  claude: SourceSession[];
  codex: SourceSession[];
  opencode: SourceSession[];
  warnings: string[];
  isDevcontainer: boolean;
  claudeHome: string;
  codexHome: string;
  opencodeDb: string;
}

function isDevcontainer(): boolean {
  if (process.env.REMOTE_CONTAINERS === "true" || process.env.CODESPACES === "true") return true;
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

function resolveOpencodeDb(): string {
  const env = process.env.OPENCODE_DB;
  if (env && env.trim() !== "") {
    if (env === ":memory:" || env.startsWith("/")) return env;
    return join(homedir(), ".local", "share", "opencode", env);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "opencode.db");
}

function decodeProjectDir(encoded: string): string {
  // dash-encoded path: -home-jack-repos-foo → /home/jack/repos/foo
  if (encoded === "-home-jack") return "/home/jack";
  // simple: replace leading - with / and remaining - with /
  // but dash encoding is "-" → "/" — e.g. "-home-jack-repos-harmoniqs-amicode" → "/home/jack/repos/harmoniqs/amicode"
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

export function discover(opts?: { homedir?: string; opencodeDb?: string }): Discovery {
  const home = opts?.homedir ?? homedir();
  const claudeHome = join(home, ".claude", "projects");
  const codexSessionsRoot = join(home, ".codex", "sessions");
  const codexArchived = join(home, ".codex", "archived_sessions");
  const codexIndexPath = join(home, ".codex", "session_index.jsonl");
  const opencodeDb = opts?.opencodeDb ?? resolveOpencodeDb();
  const warnings: string[] = [];
  const claude: SourceSession[] = [];
  const codex: SourceSession[] = [];
  const opencode: SourceSession[] = [];

  // — Claude: scan ~/.agent/projects/<encoded>/*.jsonl
  if (existsSync(claudeHome)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(claudeHome);
    } catch {
      warnings.push(`cannot read ${claudeHome}`);
    }
    for (const enc of projectDirs) {
      const dir = join(claudeHome, enc);
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const decoded = decodeProjectDir(enc);
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const full = join(dir, f);
        let size = 0;
        let mtime = 0;
        try {
          const s = statSync(full);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {
          continue;
        }
        // id is filename without .jsonl (uuid)
        const id = basename(f, ".jsonl");
        // quick title: first user message display if available — we just use id for discover,
        // parse step will extract real title; here use decoded dir as hint
        const title = `${decoded} — ${id.slice(0, 8)}`;
        claude.push({ id, title, directory: decoded, source: "claude", path: full, bytes: size, time: mtime });
      }
    }
  } else {
    if (isDevcontainer()) warnings.push(`claude home missing at ${claudeHome} (devcontainer — mount host ~/.claude)`);
  }

  // — Codex: sessions/2026/08/*/*.jsonl + archived_sessions/*.jsonl
  const codexRoots = [codexSessionsRoot, codexArchived];
  // also need to handle nested date dirs: sessions/2026/08/25/*.jsonl
  for (const root of codexRoots) {
    if (!existsSync(root)) continue;
    const collect = (dir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e);
        let st: ReturnType<typeof statSync> | undefined;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          collect(full);
        } else if (e.endsWith(".jsonl")) {
          const id = basename(e, ".jsonl").replace(/^rollout-/, "");
          // try to get title from index if available
          let size = st.size;
          let mtime = st.mtimeMs;
          // directory hint from session_meta if we can peek quickly
          let directory = "";
          try {
            const firstLine = readFileSync(full, "utf8").split("\n")[0] ?? "";
            if (firstLine) {
              const obj = JSON.parse(firstLine);
              if (obj?.payload?.cwd) directory = String(obj.payload.cwd);
              else if (obj?.payload?.session_id) directory = "";
            }
          } catch {
            // ignore
          }
          codex.push({ id, title: id.slice(0, 24), directory, source: "codex", path: full, bytes: size, time: mtime });
        }
      }
    };
    collect(root);
  }
  // enrich codex titles from session_index.jsonl if present
  if (existsSync(codexIndexPath)) {
    try {
      const lines = readFileSync(codexIndexPath, "utf8").split("\n").filter(Boolean);
      const titleMap = new Map<string, string>();
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj?.id && obj?.thread_name) titleMap.set(String(obj.id), String(obj.thread_name));
        } catch {
          // ignore
        }
      }
      for (const s of codex) {
        // id may be like 2026-08-25T10-02-08-01a0393a-... — extract uuid suffix
        const uuidMatch = s.id.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const uuid = uuidMatch?.[1];
        if (uuid && titleMap.has(uuid)) s.title = titleMap.get(uuid)!;
        else if (titleMap.has(s.id)) s.title = titleMap.get(s.id)!;
      }
    } catch {
      // ignore
    }
  }

  // — Opencode: query DB for sessions if it exists
  const dbPath = opencodeDb;
  if (existsSync(dbPath)) {
    try {
      // Use bun:sqlite if available, else skip gracefully
      // Dynamic string avoids esbuild bundling
      const { Database } = require("bun:sqlite" as string);
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.query("SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_created DESC").all() as Array<{
          id: string;
          title: string;
          directory: string;
          time_created: number;
          time_updated: number;
        }>;
        for (const r of rows) {
          opencode.push({
            id: r.id,
            title: r.title || r.id,
            directory: r.directory || "",
            source: "opencode",
            path: dbPath,
            bytes: 0,
            time: r.time_updated ?? r.time_created ?? Date.now(),
          });
        }
      } finally {
        db.close();
      }
    } catch (e) {
      // bun:sqlite not available (node) — fall back to file existence only
      warnings.push(`opencode DB found at ${dbPath} but bun:sqlite unavailable — discovery lists 0 sessions (run with bun)`);
    }
  }

  // sort newest first
  const byTime = (a: SourceSession, b: SourceSession) => b.time - a.time;
  claude.sort(byTime);
  codex.sort(byTime);
  opencode.sort(byTime);

  return {
    claude,
    codex,
    opencode,
    warnings,
    isDevcontainer: isDevcontainer(),
    claudeHome,
    codexHome: join(home, ".codex"),
    opencodeDb: dbPath,
  };
}
