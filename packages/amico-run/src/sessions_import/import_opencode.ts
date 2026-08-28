import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ExportData } from "./to_export.js";

export interface ImportResult {
  sessionId: string;
  created: boolean;
  messages: number;
  parts: number;
}

function resolveOpencodeBinary(explicit?: string): string {
  const fromArg = explicit ?? process.env.OPENCODE_BINARY;
  if (fromArg && fromArg.trim() !== "") return fromArg.trim();
  // Fall back to `opencode` on PATH (dev convenience). The extension always
  // passes the vendored binary explicitly, so this is only a local-dev nicety.
  return "opencode";
}

/**
 * Import one session by shelling out to the vendored opencode binary's canonical
 * `import` command. We write the ExportData to a temp JSON file and let opencode
 * decode it against its own strict schemas (Session.Info / SessionV1.Info / Part),
 * re-key projectID/directory/path to the process cwd, and insert idempotently.
 *
 * This deliberately replaces the old hand-rolled `bun:sqlite` writer: no bun
 * dependency, no duplicated schema knowledge, and a shape bug now fails loudly
 * (openCode's decode throws) instead of writing rows the UI can't render.
 */
export function importExportData(opts: {
  data: ExportData;
  opencode?: string;
  dbPath?: string;
  cwd?: string;
}): ImportResult {
  const binary = resolveOpencodeBinary(opts.opencode);

  const dir = mkdtempSync(join(tmpdir(), "amico-sessions-"));
  const file = join(dir, "session.json");
  try {
    writeFileSync(file, JSON.stringify(opts.data));

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.dbPath && opts.dbPath !== ":memory:") env.OPENCODE_DB = opts.dbPath;

    const res = spawnSync(binary, ["import", file], {
      env,
      cwd: opts.cwd ?? process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });

    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      throw new Error(`opencode import failed (exit ${res.status}): ${detail}`);
    }

    const messageCount = opts.data.messages.length;
    const partCount = opts.data.messages.reduce((n, m) => n + m.parts.length, 0);
    return { sessionId: opts.data.info.id, created: true, messages: messageCount, parts: partCount };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
