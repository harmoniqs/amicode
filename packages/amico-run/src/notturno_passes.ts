// The notturno scheduled-pass recorder — the TS-native port of amicissimo's
// automation/notturno/passes.py (amicode #1669): the single writer for
// scheduled-passes.md. PARITY OVER REWRITE: the section line shape and the
// header are byte-identical to the Python bot's, so a TS append onto a
// Python-written file (and vice versa) is indistinguishable — one file, two
// runners, one format. The header's "written only by python -m …" sentence is
// kept verbatim deliberately: rewording it here would fork the format during
// the boundary window; a reword, if ever wanted, is a coordinated change in
// BOTH runners plus the live file, never a unilateral TS edit.
// The job-membership check the Python append_pass performs lives one layer
// up (notturno_verb.ts) — verbs here never throw; they return {json, code}.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The dashboards-file header, byte-identical to the Python bot's. */
export const PASSES_HEADER = `---
type: dashboard
subtype: scheduled-passes
source: notturno
---

# Scheduled passes

One record per Notturno scheduled pass, newest at the bottom. Written only by
\`python -m automation.notturno.passes\` (single-writer rule, ADR 0001).
`;

export const PASS_STATUSES = ["ok", "failed"] as const;

/** One scheduled pass. `when` is a parameter so tests pin the date; the CLI
 *  passes `new Date()` (the record's date is the UTC day). */
export interface PassRecord {
  job: string;
  status: string;
  outcome: string;
  duration_s: number | null;
  artifacts: string[];
  when: Date;
}

/** Render one pass record as a markdown section — the Python render(),
 *  byte-for-byte. */
export function renderPass(record: PassRecord): string {
  const date = record.when.toISOString().slice(0, 10);
  const lines = [`## Pass ${date} — ${record.job} — ${record.status}`, "", `- ${record.outcome}`];
  if (record.duration_s !== null) lines.push(`- duration: ${record.duration_s}s`);
  if (record.artifacts.length > 0) {
    lines.push("- artifacts:");
    for (const url of record.artifacts) lines.push(`  - ${url}`);
  }
  lines.push("");
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/** Append a markdown section to scheduled-passes.md (create with header).
 *  `dashboards` may be the dashboards directory or the file itself. Returns
 *  the target path written. */
export function appendSection(dashboards: string, section: string): string {
  const target = dashboards.endsWith(".md") ? dashboards : join(dashboards, "scheduled-passes.md");
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    writeFileSync(target, readFileSync(target, "utf8").replace(/\n+$/, "") + "\n\n" + section.replace(/\n+$/, "") + "\n");
  } else {
    writeFileSync(target, PASSES_HEADER + "\n" + section.replace(/\n+$/, "") + "\n");
  }
  return target;
}
