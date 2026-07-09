// Librarian bookkeeping — the pure core behind the `amico note` verb (issue #113,
// slice B3; spec-20260708-112732 §3.1 / W-3). The librarian AGENT splits by ring:
// its INTERNAL half is DETERMINISTIC bookkeeping (write an experiment note, bump
// the system-context `best_gates`) and migrates to this CLI verb; the judgment
// half (insight extraction) stays a headless leaf. This module is that
// deterministic half — no LLM, no clock (dates/ids are passed in), fully
// unit-testable, mirroring repertoire.ts.
//
// Two operations: (1) render an experiment note with full frontmatter from a
// finished-run row; (2) bump the `best_gates` list in a system-context note,
// replacing the incumbent gate entry iff the candidate has higher fidelity.

// ── experiment note rendering ─────────────────────────────────────────────────

export interface ExperimentFields {
  platform: string;
  gate: string;
  fidelity: number;
  date: string; // ISO date "YYYY-MM-DD"
  duration_us?: number;
  status?: string; // completed | improved | failed | stalled (default completed)
  task_type?: string; // experiment | validation | regression | … (default experiment)
  session_id?: string;
  warm_start?: string; // catalog-id, or absent
  failure_mode?: string; // stagnation | divergence | … , or absent
  device?: string; // wikilink target (default "[[local-workstation]]")
  branch?: string; // default main
  desc?: string; // one-line summary for the H1 + title
}

/** `experiment-<date-compact>-<platform>-<gate>` — deterministic id/basename.
 *  A `session_id` (when present) disambiguates same-day same-gate notes. */
export function experimentId(f: ExperimentFields): string {
  const day = f.date.replace(/-/g, "");
  const suffix = f.session_id ? `-${f.session_id.slice(0, 8)}` : "";
  return `experiment-${day}-${f.platform}-${f.gate}${suffix}`;
}

function fmScalar(key: string, value: string | number | null): string {
  return `${key}: ${value === null ? "null" : value}`;
}

/** Render the full experiment note (frontmatter + body skeleton). Deterministic:
 *  no fields are invented — every value comes from `f` or a documented default. */
export function renderExperimentNote(f: ExperimentFields): string {
  const status = f.status ?? "completed";
  const taskType = f.task_type ?? "experiment";
  const device = f.device ?? "[[local-workstation]]";
  const branch = f.branch ?? "main";
  const title = f.desc ? f.desc : `${f.platform} ${f.gate} — ${status}`;
  const tags = ["experiment", f.platform, `gate/${f.gate}`, `status/${status}`, `task/${taskType}`];

  const fm = [
    "---",
    fmScalar("type", "experiment"),
    fmScalar("task_type", taskType),
    fmScalar("date", f.date),
    fmScalar("session_id", f.session_id ? `"${f.session_id}"` : "null"),
    fmScalar("platform", f.platform),
    fmScalar("gate", f.gate),
    fmScalar("fidelity", f.fidelity),
    fmScalar("duration_us", f.duration_us ?? "null"),
    fmScalar("status", status),
    fmScalar("failure_mode", f.failure_mode ?? "null"),
    fmScalar("warm_start", f.warm_start ? `"${f.warm_start}"` : "null"),
    fmScalar("device", `"${device}"`),
    fmScalar("branch", branch),
    `tags: [${tags.join(", ")}]`,
    "---",
  ].join("\n");

  const infidelity = 1 - f.fidelity;
  const body = [
    "",
    `# Exp: ${title}`,
    "",
    "## Setup",
    `- Platform: ${f.platform}`,
    `- Gate: ${f.gate}`,
    `- Warm-start: ${f.warm_start ?? "null (cold start)"}`,
    `- Device: ${device}`,
    "",
    "## Result",
    `- $\\mathcal{F} = ${f.fidelity}$ (infidelity $1 - \\mathcal{F} = ${infidelity.toExponential(3)}$)`,
    f.duration_us !== undefined ? `- Duration: ${f.duration_us} µs` : "- Duration: (not recorded)",
    `- Status: ${status}`,
    f.failure_mode ? `- Failure mode: ${f.failure_mode}` : "",
    "",
    "## Analysis",
    "- (bookkeeping stub written by `amico note write`; extend with interpretation.)",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return fm + "\n" + body + "\n";
}

// ── best_gates bump ───────────────────────────────────────────────────────────

export interface BestGate {
  gate: string;
  fidelity: number;
  duration_ns?: number;
  source?: string; // wikilink to the experiment/catalog entry
}

export interface MergeResult {
  gates: BestGate[];
  bumped: boolean; // did the list change?
  previous?: BestGate; // the incumbent entry for this gate, if any
  reason: string;
}

/** Replace the incumbent entry for `entry.gate` iff the candidate has strictly
 *  higher fidelity; add it if absent; otherwise no-op. Pure — returns a new list
 *  (input untouched), sorted by gate name for a stable, diff-friendly file. */
export function mergeBestGates(existing: BestGate[], entry: BestGate): MergeResult {
  const previous = existing.find((g) => g.gate === entry.gate);
  if (!previous) {
    const gates = [...existing, entry].sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
    return { gates, bumped: true, reason: `added ${entry.gate} (no prior best_gate)` };
  }
  if (entry.fidelity > previous.fidelity) {
    const gates = existing.map((g) => (g.gate === entry.gate ? entry : g));
    return { gates, bumped: true, previous, reason: `bumped ${entry.gate}: ${previous.fidelity} → ${entry.fidelity}` };
  }
  return {
    gates: existing,
    bumped: false,
    previous,
    reason: `did not bump ${entry.gate}: candidate ${entry.fidelity} ≤ incumbent ${previous.fidelity}`,
  };
}

/** Parse one inline-table best_gate entry: `{gate: X, fidelity: 0.99,
 *  duration_ns: 37, source: "[[..]]"}`. Returns undefined if it lacks the
 *  discriminating fields (gate + fidelity). */
export function parseBestGate(inline: string): BestGate | undefined {
  const body = inline.trim().replace(/^\{/, "").replace(/\}$/, "");
  const fields: Record<string, string> = {};
  for (const pair of splitTopLevel(body)) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  const gate = fields.gate?.replace(/^["']|["']$/g, "");
  const fidelity = fields.fidelity !== undefined ? Number(fields.fidelity) : NaN;
  if (!gate || !Number.isFinite(fidelity)) return undefined;
  const g: BestGate = { gate, fidelity };
  if (fields.duration_ns !== undefined && Number.isFinite(Number(fields.duration_ns)))
    g.duration_ns = Number(fields.duration_ns);
  if (fields.source !== undefined) g.source = fields.source.replace(/^["']|["']$/g, "");
  return g;
}

/** Split an inline-table body on commas that are NOT inside quotes/brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function serializeBestGate(g: BestGate): string {
  const parts = [`gate: ${g.gate}`, `fidelity: ${g.fidelity}`];
  if (g.duration_ns !== undefined) parts.push(`duration_ns: ${g.duration_ns}`);
  if (g.source !== undefined) parts.push(`source: "${g.source}"`);
  return `  - {${parts.join(", ")}}`;
}

export interface BumpTextResult {
  ok: boolean;
  text?: string; // the rewritten note (only when ok)
  bumped?: boolean;
  previous?: BestGate;
  reason: string;
}

/** Bump the `best_gates` block of a system-context note (given its full text) with
 *  `entry`. Pure text surgery: parses the block (both `best_gates: []` and the
 *  multi-line list form), merges, re-serializes ONLY that block, leaving the rest
 *  of the note byte-identical. Errors (no frontmatter / no `best_gates:` key) are
 *  returned, never thrown. */
export function bumpBestGatesInText(text: string, entry: BestGate): BumpTextResult {
  if (!text.startsWith("---")) return { ok: false, reason: "not a note: no leading frontmatter" };
  const fmEnd = text.indexOf("\n---", 3);
  if (fmEnd === -1) return { ok: false, reason: "malformed frontmatter (no closing ---)" };

  const lines = text.split("\n");
  // Frontmatter spans lines[1 .. closeIdx-1]; find the closing `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { ok: false, reason: "malformed frontmatter (no closing ---)" };

  // Locate `best_gates:` within the frontmatter.
  let keyIdx = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (/^best_gates:/.test(lines[i])) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) return { ok: false, reason: "no `best_gates:` key in the note frontmatter" };

  // The block: the key line plus following list items (indented `-`), until the
  // next top-level frontmatter key or the closing ---.
  const keyLine = lines[keyIdx];
  const existing: BestGate[] = [];
  let blockEnd = keyIdx + 1; // first line NOT part of the block
  const inlineEmpty = /^best_gates:\s*\[\s*\]\s*$/.test(keyLine);
  if (!inlineEmpty) {
    for (let i = keyIdx + 1; i < closeIdx; i++) {
      const l = lines[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(l)) break; // next top-level key
      blockEnd = i + 1;
      const m = l.match(/^\s*-\s*(\{.*\})\s*$/);
      if (m) {
        const g = parseBestGate(m[1]);
        if (g) existing.push(g);
      }
    }
  }

  const merge = mergeBestGates(existing, entry);
  if (!merge.bumped) return { ok: true, text, bumped: false, previous: merge.previous, reason: merge.reason };

  const newBlock =
    merge.gates.length === 0 ? ["best_gates: []"] : ["best_gates:", ...merge.gates.map(serializeBestGate)];
  const rebuilt = [...lines.slice(0, keyIdx), ...newBlock, ...lines.slice(blockEnd)].join("\n");
  return { ok: true, text: rebuilt, bumped: true, previous: merge.previous, reason: merge.reason };
}
