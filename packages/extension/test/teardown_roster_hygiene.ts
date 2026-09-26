// Global teardown: remove test-leaked entries from the real fleet roster.
//
// The fleet tests are hermetic — they write to temp dirs and in-memory stubs,
// never ~/.amico/ops/fleet/roster.json. But *manual* `amico fleet enroll`
// invocations during development can leak test-like values (the recorder()
// helper's defaults: name "workbench", timestamp "2026-01-01T00:00:00.000Z")
// into the real roster, which then shows ghost devices in the fleet sidebar.
//
// This teardown is the safety net: it runs once after the full suite and
// removes any entry whose `last_report` is the test-sentinel timestamp.
// Idempotent, harmless if the file doesn't exist or has no test entries.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SENTINEL_TIMESTAMP = "2026-01-01T00:00:00";

export default function teardown() {
  const rosterPath = join(homedir(), ".amico", "ops", "fleet", "roster.json");
  if (!existsSync(rosterPath)) return;

  let doc: { schema_version?: number; rows?: Array<{ last_report?: string; name?: string; machine_id?: string }> };
  try {
    doc = JSON.parse(readFileSync(rosterPath, "utf8"));
  } catch {
    return; // corrupt or unreadable — not our problem
  }

  if (!Array.isArray(doc.rows)) return;

  const before = doc.rows.length;
  doc.rows = doc.rows.filter(
    (r) => !r.last_report?.startsWith(TEST_SENTINEL_TIMESTAMP),
  );
  const removed = before - doc.rows.length;

  if (removed > 0) {
    writeFileSync(rosterPath, JSON.stringify(doc, null, 2) + "\n");
    console.log(
      `[roster-hygiene] removed ${removed} test-leaked roster entry(s) from ${rosterPath}`,
    );
  }
}
