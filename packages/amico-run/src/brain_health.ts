// brain_health.ts — the pure core behind `amico brain-health` (amicode #1687,
// brain flywheel slice 8 — the brain measures itself): the monthly KPI report
// over the flywheel's pass receipts and claim state.
//
// DOCTRINE (#1679 / #1687 Key Decisions):
//   - The report MEASURES, never acts: no fixes, no stamping, no transitions
//     ride this pass. The only bytes the verb ever writes are the dated brief
//     itself and the pass's own receipt — never a substrate.
//   - Numbers carry provenance to the receipts that produced them: every KPI
//     keeps the receipt dates / claim files it was computed from, and the
//     render prints them.
//   - No ad-hoc recomputation: the report READS the receipts' own counts (the
//     writers' pinned outcome shapes) and the state's own renderings (the
//     review queue's rendered count, the distill state stamp). It never
//     re-runs the lint, the lifecycle pass, or the classifier.
//   - Honest degradation: a substrate that was not given is stated as
//     unmeasured (null + a named finding), never faked as zero; a receipt
//     whose outcome left its writer's pinned shape is a named finding, never
//     a silent skip.
//
// THE FIVE KPI FAMILIES (the issue's AC):
//   1. claims created vs applied — created from the distill receipts' own
//      `claims` counts; applied from the registry claims' `applied` history
//      events; the ratio closes the loop.
//   2. time-to-distill — the candidate notes' own `distilled_at` vs
//      `session_updated` (the artery's staleness).
//   3. pending backlog trends — the distill backlog (the latest receipt's
//      substantive count minus the state stamp's ever-distilled sessions),
//      the review queue (the lifecycle's rendered count), and the pending-tag
//      intake (the extract-meetings receipts' acted/skipped throughput).
//   4. refutation rate — refuted vs corroborated history events in period
//      (claim state), plus the registry snapshot.
//   5. schema compliance — the prune receipts' own drift-finding counts, the
//      lint findings trend.
//
// PURITY: no clock (dates passed in); the loaders take explicit paths and
// never throw; the renderers are deterministic — same inputs + same clock →
// identical bytes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { RegistryClaim } from "./claims.js";

/** The notturno job id this verb registers as (the registry's job truth, the
 *  spec's monthly slot: `brain-health`). */
export const BRAIN_HEALTH_JOB = "brain-health";

// ── the receipt parser (the journal's own bytes, read by its writer's shape) ──

/** One scheduled-pass section of scheduled-passes.md — the notturno_passes
 *  render() shape: `## Pass <date> — <job> — <status>` + the outcome bullet
 *  (+ optional duration / artifacts lines, which the KPIs never read). */
export interface PassReceipt {
  date: string;
  job: string;
  status: string;
  outcome: string;
  duration_s: number | null;
  artifacts: string[];
}

/** The section header's exact separator (renderPass: ` — `, em-dash). */
const SECTION_RE = /^## Pass (\d{4}-\d{2}-\d{2}) — (.+) — (ok|failed)$/;

/** Parse the receipts journal. Only `## Pass` sections are records; any other
 *  line is the file's header/prose (ignored). A malformed section header is a
 *  named finding — the journal is single-writer, so drift is a loud signal. */
export function parsePasses(raw: string): { receipts: PassReceipt[]; findings: string[] } {
  const receipts: PassReceipt[] = [];
  const findings: string[] = [];
  const lines = raw.split("\n");
  let current: { head: string; date: string; job: string; status: string } | undefined;
  let outcome: string | undefined;
  let durationS: number | null = null;
  let artifacts: string[] = [];
  let rawHead = "";

  const flush = () => {
    if (current === undefined) return;
    receipts.push({
      date: current.date,
      job: current.job,
      status: current.status,
      outcome: outcome ?? "",
      duration_s: durationS,
      artifacts,
    });
  };

  for (const line of lines) {
    if (line.startsWith("## Pass ")) {
      flush();
      current = undefined;
      outcome = undefined;
      durationS = null;
      artifacts = [];
      rawHead = line;
      const m = SECTION_RE.exec(line);
      if (m === null) {
        findings.push(`malformed pass section header: "${line.trim()}" (expected "## Pass <YYYY-MM-DD> — <job> — <ok|failed>") — skipped`);
        continue;
      }
      current = { head: line, date: m[1]!, job: m[2]!, status: m[3]! };
      continue;
    }
    if (current === undefined) continue; // header/prose between sections
    if (line.startsWith("- duration: ") && line.endsWith("s")) {
      const n = Number(line.slice("- duration: ".length, -1));
      if (Number.isFinite(n)) durationS = n;
      continue;
    }
    if (line.startsWith("- artifacts:")) continue;
    if (line.startsWith("  - ")) {
      artifacts.push(line.slice(4));
      continue;
    }
    if (line.startsWith("- ") && outcome === undefined) outcome = line.slice(2);
  }
  flush();
  return { receipts, findings };
}

// ── the pinned outcome shapes (the writers' own formats — the provenance) ─────
//
// One regex per job, pinned to the exact outcome line its verb files. A
// receipt that no longer matches is a NAMED finding (the writer evolved, the
// report says so) and is excluded from that family's numbers — the report
// never guesses a count.

const DISTILL_RE =
  /^distill: scanned (\d+) sessions \(substantive (\d+), junk (\d+)\), distilled (\d+), claims (\d+), none (\d+), errors (\d+)$/;
const PRUNE_RE = /^prune: (\d+) fixes applied \((\d+) unambiguous findings\), (\d+) drift findings flagged for a human$/;
const EXTRACT_ACTED_RE =
  /^extract-meetings: proposed tags for (.+) \(products (\d+), projects (\d+), entities (\d+), types (\d+), themes (\d+)\), (\d+) named gaps, proposed (\d+) hopper item\(s\)$/;
const EXTRACT_SKIPPED_RE = /^extract-meetings: skipped (.+) \(status (.+)\)$/;
const PROMOTE_RE = /^promote: (\d+) claims proposed \(bundle ([^)]*)\), overflow (\d+) carried(?:, excluded (\d+))?/;
const SYNTHESIZE_RE = /^synthesize: (\d+) hopper proposals, (\d+) already proposed \(skipped\), (\d+) patterns carried/;
const TRIAGE_PAPERS_RE = /^triage-papers: scanned (\d+) papers \(high (\d+)\), seeded (\d+), no-match (\d+), skipped (\d+)$/;
const BRAIN_HEALTH_RE =
  /^brain-health: period (\d{4}-\d{2}) — receipts (\d+), claims (\d+), created (\d+), applied (\d+), refuted (\d+), drift (\d+) — brief (.+)$/;

// ── the state loaders (explicit paths, never throw) ───────────────────────────

/** One candidate stamp: the distill candidate note's own provenance fields. */
export interface CandidateStamp {
  file: string;
  session_id: string;
  session_updated: string;
  distilled_at: string;
}

/** Load the candidate area's stamps (the #1680 candidate notes' own
 *  frontmatter: session_id, session_updated, distilled_at). A note missing
 *  any field is a NAMED skip — a stamp is never guessed. */
export function loadCandidateStamps(candidatesDir: string): { stamps: CandidateStamp[]; skipped: string[] } {
  const stamps: CandidateStamp[] = [];
  const skipped: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(candidatesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { stamps: [], skipped: [] }; // no candidate area → no stamps (the verb states it)
  }
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(join(candidatesDir, file), "utf8"));
    if (!fm.ok) {
      skipped.push(`${file}: ${fm.error}`);
      continue;
    }
    const sessionId = fm.data.session_id;
    const updated = fm.data.session_updated;
    const distilledAt = fm.data.distilled_at;
    if (typeof sessionId !== "string" || typeof updated !== "string" || typeof distilledAt !== "string") {
      skipped.push(`${file}: not a distill candidate note (session_id/session_updated/distilled_at) — skipped, never guessed`);
      continue;
    }
    stamps.push({ file, session_id: sessionId, session_updated: updated, distilled_at: distilledAt });
  }
  return { stamps, skipped };
}

/** Read the review queue's own rendered count (the lifecycle's renderQueueFile
 *  title carries it — the projection's number, not a recomputation). Missing
 *  file → null (unmeasured, never zero-faked); unreadable/unknown shape → null
 *  + a named finding. */
export function readReviewQueueCount(queueFile: string): { count: number | null; finding?: string } {
  if (!existsSync(queueFile)) return { count: null };
  let raw: string;
  try {
    raw = readFileSync(queueFile, "utf8");
  } catch (e) {
    return { count: null, finding: `review queue unreadable: ${queueFile} (${e instanceof Error ? e.message : String(e)})` };
  }
  const title = /^# Claims review queue — (\d+) beyond the (\d+)-day decay window$/m.exec(raw);
  if (title !== null) return { count: Number(title[1]) };
  if (/^no claims beyond the \d+-day decay window/m.test(raw)) return { count: 0 };
  return { count: null, finding: `review queue ${queueFile}: unrecognized rendering (not the lifecycle's queue file shape) — unmeasured` };
}

/** Count the meeting vault's pending-tag notes (the #1686 intake's backlog:
 *  type `meeting` + status `pending-tag`, the vault's own state). Read-only;
 *  an unreadable root degrades to null + a finding. */
export function countPendingTagMeetings(meetingsRoot: string): { count: number | null; finding?: string } {
  const notesRoot = join(meetingsRoot, "notes");
  let count = 0;
  let sawAny = false;
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(path)) return false;
        continue;
      }
      if (!entry.name.endsWith(".md") || entry.name.endsWith(".transcript.md")) continue;
      sawAny = true;
      const fm = parseFrontmatter(readFileSync(path, "utf8"));
      if (fm.ok && fm.data.type === "meeting" && fm.data.status === "pending-tag") count += 1;
    }
    return true;
  };
  if (!existsSync(notesRoot)) return { count: null, finding: `no meetings notes tree at ${notesRoot} — the pending-tag backlog is unmeasured` };
  if (!walk(notesRoot)) return { count: null, finding: `meetings notes tree unreadable: ${notesRoot} — the pending-tag backlog is unmeasured` };
  if (!sawAny) return { count: 0, finding: `no meeting notes found under ${notesRoot} — the pending-tag backlog reads as an empty intake` };
  return { count };
}

// ── the report ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface HealthInput {
  /** the period under report, YYYY-MM — receipts/history are windowed on it */
  period: string;
  receipts: PassReceipt[];
  claims: RegistryClaim[];
  candidates: CandidateStamp[];
  /** the review queue's own rendered count; null = unmeasured */
  review_queue: number | null;
  /** the meeting vault's pending-tag count; null = unmeasured */
  pending_tag: number | null;
  /** the distill state stamp's entry count (sessions ever distilled); null = unmeasured */
  distill_stamped: number | null;
}

export interface CreatedVsApplied {
  created: number;
  created_provenance: string[];
  applied: number;
  applied_provenance: string[];
  ratio: number | null;
}

export interface TimeToDistill {
  count: number;
  median_days: number | null;
  max_days: number | null;
}

export interface DistillBacklog {
  /** the latest distill receipt's own substantive count */
  latest_substantive: number | null;
  /** the state stamp's ever-distilled count */
  stamped: number | null;
  /** max(0, latest_substantive − stamped) when both measured; null otherwise */
  backlog: number | null;
  /** the period's per-pass throughput rows (the receipts' own counts) */
  series: { date: string; scanned: number; substantive: number; distilled: number; claims: number; errors: number }[];
}

export interface RefutationKpi {
  refuted: number;
  corroborated: number;
  /** refuted / (refuted + corroborated) in period; null when the denominator is 0 */
  rate: number | null;
  total_claims: number;
  refuted_claims: number;
  snapshot_pct: number | null;
}

export interface SchemaCompliance {
  series: { date: string; fixes: number; drift: number }[];
  latest_drift: number | null;
}

export interface HealthReport {
  period: string;
  receipts: { total: number; in_period: number; by_job: Record<string, number> };
  created_vs_applied: CreatedVsApplied;
  time_to_distill: TimeToDistill;
  backlogs: {
    distill: DistillBacklog;
    review_queue: number | null;
    pending_tag: { backlog: number | null; acted: number; skipped: number };
  };
  refutation: RefutationKpi;
  schema_compliance: SchemaCompliance;
  findings: string[];
}

/** One claim's history entries, parsed defensively (the loader already
 *  validated the claim, so a non-array history is machinery's bug, not a
 *  substrate's — degrade to []). */
function historyOf(claim: Record<string, unknown>): { date: string; event: string }[] {
  return Array.isArray(claim.history) ? (claim.history as { date: string; event: string }[]) : [];
}

function inPeriod(date: string, period: string): boolean {
  return date.startsWith(`${period}-`);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The five KPI families over one period. Pure; never throws; every refusal
 *  and unmeasurable is a named finding. FAILED passes are counted in the
 *  receipts meta (a failure is a fact) but excluded from every family — their
 *  outcomes are not the writers' ok shapes, and that is NOT drift. */
export function computeHealthReport(input: HealthInput): HealthReport {
  const findings: string[] = [];
  const period = input.period;
  const okReceipts = input.receipts.filter((r) => r.status === "ok");
  const inPeriodAll = input.receipts.filter((r) => inPeriod(r.date, period));
  const inPeriodOk = okReceipts.filter((r) => inPeriod(r.date, period));

  // receipts meta: every pass in period, whatever its status
  const by_job: Record<string, number> = {};
  for (const r of inPeriodAll) by_job[r.job] = (by_job[r.job] ?? 0) + 1;

  // pre-parse the distill receipts ONCE (each unparseable ok receipt is ONE
  // finding, shared by every family that reads it)
  const distillParsed = new Map<PassReceipt, { scanned: number; substantive: number; distilled: number; claims: number; errors: number }>();
  for (const r of okReceipts) {
    if (r.job !== "distill") continue;
    const m = DISTILL_RE.exec(r.outcome);
    if (m === null) {
      findings.push(`receipt ${r.date} (distill): outcome left the writer's pinned shape — "${r.outcome}" — excluded from every distill KPI`);
      continue;
    }
    distillParsed.set(r, { scanned: Number(m[1]), substantive: Number(m[2]), distilled: Number(m[4]), claims: Number(m[5]), errors: Number(m[7]) });
  }
  const distillOkInPeriod = inPeriodOk.filter((r) => distillParsed.has(r));

  // ── family 1: claims created vs applied ──
  const created_provenance: string[] = [];
  let created = 0;
  for (const r of distillOkInPeriod) {
    const parsed = distillParsed.get(r)!;
    created += parsed.claims;
    created_provenance.push(`${r.date}: claims ${parsed.claims}`);
  }
  if (created === 0) findings.push(`no parseable distill receipts in ${period} — the created side of created-vs-applied reads as 0`);
  const applied_provenance: string[] = [];
  let applied = 0;
  for (const { file, claim } of input.claims) {
    const n = historyOf(claim).filter((h) => h.event === "applied" && inPeriod(h.date, period)).length;
    if (n === 0) continue;
    applied += n;
    applied_provenance.push(`${file}: ${n} applied event(s)`);
  }
  const ratio = created > 0 ? applied / created : null;
  if (created === 0) findings.push(`no distill receipts in ${period} — the created side of created-vs-applied reads as 0`);

  // ── family 2: time-to-distill (the candidate notes' own two timestamps) ──
  const samples: number[] = [];
  for (const c of input.candidates) {
    if (!inPeriod(c.distilled_at, period)) continue;
    const distilled = Date.parse(c.distilled_at);
    const updated = Date.parse(c.session_updated);
    if (!Number.isFinite(distilled) || !Number.isFinite(updated)) {
      findings.push(`${c.file}: unparseable distilled_at/session_updated — excluded from time-to-distill`);
      continue;
    }
    const days = (distilled - updated) / DAY_MS;
    if (days < 0) {
      findings.push(`${c.file}: distilled_at precedes session_updated (${c.distilled_at} < ${c.session_updated}) — excluded from time-to-distill`);
      continue;
    }
    samples.push(days);
  }
  const time_to_distill: TimeToDistill = {
    count: samples.length,
    median_days: median(samples),
    max_days: samples.length === 0 ? null : Math.max(...samples),
  };

  // ── family 3a: the distill backlog (latest receipt's substantive − state stamp) ──
  let latest_substantive: number | null = null;
  for (const r of okReceipts) {
    const parsed = distillParsed.get(r);
    if (parsed !== undefined) latest_substantive = parsed.substantive; // the LAST parseable receipt is the latest worklist
  }
  if (latest_substantive === null) findings.push("no parseable distill receipts — the distill backlog's substantive side is unmeasured");
  if (input.distill_stamped === null) findings.push("no distill state stamp given — the distill backlog's stamped side is unmeasured");
  const raw_backlog =
    latest_substantive !== null && input.distill_stamped !== null ? latest_substantive - input.distill_stamped : null;
  const backlog = raw_backlog === null ? null : Math.max(0, raw_backlog);
  if (raw_backlog !== null && raw_backlog < 0)
    findings.push(
      `distill backlog computed as ${raw_backlog} (stamped ${input.distill_stamped} > latest substantive ${latest_substantive} — archived sessions leave the worklist); reported as 0`,
    );
  const series: DistillBacklog["series"] = distillOkInPeriod.map((r) => {
    const parsed = distillParsed.get(r)!;
    return { date: r.date, ...parsed };
  });

  // ── family 3b: the review queue (its own rendered count) ──
  if (input.review_queue === null) findings.push("no review queue given — the decay review backlog is unmeasured");

  // ── family 3c: the pending-tag intake (receipts throughput + the vault state) ──
  let acted = 0;
  let skipped = 0;
  for (const r of inPeriodOk) {
    if (r.job !== "extract-meetings") continue;
    if (EXTRACT_ACTED_RE.test(r.outcome)) acted += 1;
    else if (EXTRACT_SKIPPED_RE.test(r.outcome)) skipped += 1;
    else findings.push(`receipt ${r.date} (extract-meetings): outcome left the writer's pinned shape — "${r.outcome}" — excluded from the pending-tag throughput`);
  }
  if (input.pending_tag === null) findings.push("no meetings root given — the pending-tag backlog is unmeasured");

  // ── family 4: refutation rate (the registry's own history trail) ──
  let refuted = 0;
  let corroborated = 0;
  for (const { claim } of input.claims) {
    for (const h of historyOf(claim)) {
      if (!inPeriod(h.date, period)) continue;
      if (h.event === "refuted") refuted += 1;
      if (h.event === "corroborated") corroborated += 1;
    }
  }
  const denominator = refuted + corroborated;
  const refuted_claims = input.claims.filter((c) => c.claim.status === "refuted").length;
  const refutation: RefutationKpi = {
    refuted,
    corroborated,
    rate: denominator > 0 ? refuted / denominator : null,
    total_claims: input.claims.length,
    refuted_claims,
    snapshot_pct: input.claims.length > 0 ? refuted_claims / input.claims.length : null,
  };
  if (denominator === 0) findings.push(`no refuted or corroborated history events in ${period} — the refutation rate is unmeasured this period`);

  // ── family 5: schema compliance (the prune receipts' own drift counts) ──
  const compliance: { date: string; fixes: number; drift: number }[] = [];
  for (const r of inPeriodOk) {
    if (r.job !== "prune") continue;
    const m = PRUNE_RE.exec(r.outcome);
    if (m === null) {
      findings.push(`receipt ${r.date} (prune): outcome left the writer's pinned shape — "${r.outcome}" — excluded from the lint findings trend`);
      continue;
    }
    compliance.push({ date: r.date, fixes: Number(m[1]), drift: Number(m[3]) });
  }
  const schema_compliance: SchemaCompliance = {
    series: compliance,
    latest_drift: compliance.length === 0 ? null : compliance[compliance.length - 1]!.drift,
  };
  if (compliance.length === 0) findings.push(`no parseable prune receipts in ${period} — the lint findings trend is unmeasured this period`);

  return {
    period,
    receipts: { total: input.receipts.length, in_period: inPeriodAll.length, by_job },
    created_vs_applied: { created, created_provenance, applied, applied_provenance, ratio },
    time_to_distill,
    backlogs: {
      distill: { latest_substantive, stamped: input.distill_stamped, backlog, series },
      review_queue: input.review_queue,
      pending_tag: { backlog: input.pending_tag, acted, skipped },
    },
    refutation,
    schema_compliance,
    findings,
  };
}

// ── the brief render (the dated publication — deterministic) ─────────────────

function pct(v: number | null): string {
  return v === null ? "unmeasured" : `${(v * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function days(v: number | null): string {
  return v === null ? "unmeasured" : `${v.toFixed(2).replace(/\.?0+$/, "")} days`;
}

function number(v: number | null): string {
  return v === null ? "unmeasured" : String(v);
}

/** Render the monthly health brief. Deterministic: same report + same
 *  generated_at → identical bytes. Every number line carries its provenance;
 *  unmeasured families say so, never a faked zero. */
export function renderHealthBrief(report: HealthReport, meta: { generated_at: string }): string {
  const b = report.backlogs;
  const distillSeries =
    b.distill.series.length === 0
      ? ["- distill passes this period: none on the journal"]
      : [
          `- distill passes this period: ${b.distill.series.length} (receipts' own counts)`,
          ...b.distill.series.map((s) => `  - ${s.date}: scanned ${s.scanned}, substantive ${s.substantive}, distilled ${s.distilled}, claims ${s.claims}, errors ${s.errors}`),
        ];

  return [
    "<!--",
    "generated view — `amico brain-health` (amicode #1687, brain flywheel slice 8, notturno job `brain-health`)",
    "the brain measures itself: the monthly KPI report over the flywheel's pass receipts and",
    "claim state. The report MEASURES, never acts — nothing is fixed, stamped, or transitioned",
    "by this pass. Every number carries the provenance that produced it; unmeasured families",
    "are stated, never faked. Hand-edits are regenerated away by design.",
    "-->",
    "",
    `# Brain health — ${report.period}`,
    "",
    `Generated ${meta.generated_at} by the monthly brain-health pass.`,
    `Inputs: ${report.receipts.total} receipts on the journal (${report.receipts.in_period} in period), ${report.refutation.total_claims} registry claims,`,
    `${report.time_to_distill.count} candidates distilled in period, the review queue, and the meetings intake.`,
    "",
    "## 1 — Claims created vs applied",
    "",
    `- created: **${report.created_vs_applied.created}** candidates this period (the distill receipts' own counts)`,
    ...report.created_vs_applied.created_provenance.map((p) => `  - ${p}`),
    `- applied: **${report.created_vs_applied.applied}** adoptions this period (the registry claims' applied history events)`,
    ...report.created_vs_applied.applied_provenance.map((p) => `  - ${p}`),
    `- adoption ratio: **${pct(report.created_vs_applied.ratio)}** (applied / created)`,
    "",
    "## 2 — Time-to-distill",
    "",
    `- **${report.time_to_distill.count}** candidates distilled this period`,
    `- median: **${days(report.time_to_distill.median_days)}** from last session activity to distillation (candidate notes' distilled_at vs session_updated)`,
    `- max: **${days(report.time_to_distill.max_days)}**`,
    "",
    "## 3 — Pending backlog trends",
    "",
    ...distillSeries,
    `- distill backlog: **${number(b.distill.backlog)}** (latest receipt's substantive ${number(b.distill.latest_substantive)} − state stamp's ever-distilled ${number(b.distill.stamped)})`,
    `- review queue: **${number(b.review_queue)}** claims beyond the decay window (the lifecycle's rendered count)`,
    `- pending-tag: **${number(b.pending_tag.backlog)}** meeting notes still awaiting tagging; this period: ${b.pending_tag.acted} acted, ${b.pending_tag.skipped} skipped (extract-meetings receipts)`,
    "",
    "## 4 — Refutation rate",
    "",
    `- refuted this period: **${report.refutation.refuted}** · corroborated this period: **${report.refutation.corroborated}** (the claims' history trails)`,
    `- refutation rate: **${pct(report.refutation.rate)}** (refuted / (refuted + corroborated), from the claims' history trails)`,
    `- registry snapshot: **${report.refutation.refuted_claims} of ${report.refutation.total_claims}** claims currently refuted (**${pct(report.refutation.snapshot_pct)}**)`,
    "",
    "## 5 — Schema compliance (lint findings trend)",
    "",
    ...(report.schema_compliance.series.length === 0
      ? ["- no prune receipts this period — the lint findings trend is unmeasured"]
      : [
          `- prune drift findings: **${report.schema_compliance.series.map((s) => s.drift).join(" → ")}** across ${report.schema_compliance.series.length} prune passes (the prune receipts' own counts)`,
          ...report.schema_compliance.series.map((s) => `  - ${s.date}: ${s.fixes} fixes applied, ${s.drift} drift findings flagged for a human`),
          `- latest drift: **${number(report.schema_compliance.latest_drift)}** findings flagged for a human`,
        ]),
    "",
    ...(report.findings.length > 0 ? ["## Findings (the report is never silent)", "", ...report.findings.map((f) => `- ${f}`), ""] : []),
  ].join("\n");
}
