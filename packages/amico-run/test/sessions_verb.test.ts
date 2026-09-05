// `amico sessions` — D4 slice 3 (issue #795): session retention that relocates +
// the generated session index. Pure core (session_retention.ts) is unit-tested
// against src; the verb bodies run through `dist/amico.js` against SEEDED COPY
// databases in temp dirs — never the live chat DB (shared with a running hub).
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ARCHIVE_DAYS,
  readArchiveDays,
  writeArchiveDays,
  retentionPrefsFile,
} from "../src/session_retention.js";

// ── AC 3: the archive cutoff is a workspace preference with default 30 days ──
describe("retention preference — the archive cutoff", () => {
  let ops: string;
  beforeEach(() => {
    ops = mkdtempSync(join(tmpdir(), "amico-sessions-ops-"));
  });
  afterEach(() => rmSync(ops, { recursive: true, force: true }));

  it("defaults to 30 days when no preference file exists (fresh install)", () => {
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    expect(DEFAULT_ARCHIVE_DAYS).toBe(30);
  });

  it("fails safe to 30 on a malformed or out-of-range preference file", () => {
    writeFileSync(join(ops, "session-retention.json"), "{not json");
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: 0 }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: -5 }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: "thirty" }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
  });

  it("reads a written preference (7 days) and reports the file it came from", () => {
    writeArchiveDays(7, { AMICODE_OPS_DIR: ops });
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(7);
    expect(retentionPrefsFile({ AMICODE_OPS_DIR: ops })).toBe(join(ops, "session-retention.json"));
    const parsed = JSON.parse(readFileSync(retentionPrefsFile({ AMICODE_OPS_DIR: ops }), "utf8"));
    expect(parsed).toMatchObject({ schema_version: 1, archive_days: 7 });
  });

  it("refuses to write a non-positive or non-integer cutoff", () => {
    expect(writeArchiveDays(0, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(writeArchiveDays(2.5, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(existsSync(join(ops, "session-retention.json"))).toBe(false);
  });

  it("falls back to ~/.amico/amicode when AMICODE_OPS_DIR is unset", () => {
    expect(retentionPrefsFile({})).toBe(join(homedir(), ".amico", "amicode", "session-retention.json"));
  });
});
