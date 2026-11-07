// brain_health_verb.ts — `amico brain-health` (amicode #1687, brain flywheel
// slice 8 — the brain measures itself): the monthly notturno job that renders
// the health report from the flywheel's pass receipts + claim state and
// publishes it as a dated brief in the vault's briefs area.
//
// THE REPORT MEASURES, NEVER ACTS (#1687's Key Decision): the only bytes this
// verb writes are the brief itself (period-keyed: briefs/health-YYYY-MM.md —
// idempotent per period, a re-run overwrites its own brief, the re-distill
// doctrine) and, with --jobs, the pass's own receipt. Every substrate — the
// receipts journal, the claims registry, the candidate area, the review queue,
// the meetings vault — is opened READ-ONLY. No fixes, no stamping, no
// transitions: nothing downstream of this pass ever moves.
//
// THE RECEIPT (the distill/curation chassis): with `--jobs <notturno.toml>`
// the apply run files a scheduled-passes.md record — job id `brain-health`,
// the period's headline numbers in the outcome, the brief as the artifact.
// The chassis gates apply verbatim: the instance deny-list first (org config
// never runs through this public verb — it fires BEFORE any body work), then
// the registry membership check (an unknown job id is exit 2), then the
// record-mode self-filter. Without --jobs the body still runs and the receipt
// is honestly not filed (a private instance composes its own through its own
// runner).
//
// MODES (the S2 convention): dry-run by default (report-only: the JSON carries
// the KPIs + the rendered brief, nothing is written, no receipt); `--apply`
// writes. dry/apply are explicit in the JSON.
//
// HONEST SUBSTRATES: every input is a read of state another slice owns — the
// receipts journal (notturno_passes' own shape), the registry (the slice-2/3
// loader), the candidate area (the #1680 notes' own frontmatter), the review
// queue (the lifecycle's own rendered count), the distill state stamp (the
// #1680 stamp), the meetings intake (the #1686 status frontmatter). Optional
// substrates degrade to stated-unmeasured findings, never faked numbers.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRegistryClaims } from "./claims.js";
import { readDistillState } from "./distill.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import {
  BRAIN_HEALTH_JOB,
  computeHealthReport,
  countPendingTagMeetings,
  loadCandidateStamps,
  parsePasses,
  readReviewQueueCount,
  renderHealthBrief,
} from "./brain_health.js";
import { triageDenyGate, triageJobReceipt } from "./triage.js";
import { amicodeOpsDir } from "./session_retention.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico brain-health [--period YYYY-MM] [--dashboards <dir|file>] [--registry <claims dir>]",
  "                   [--candidates <dir>] [--state <distill-state.json>] [--queue <review-queue.md>]",
  "                   [--meetings <meeting vault root>] [--out <brief file> | --briefs <dir>]",
  "                   [--jobs <notturno.toml>] [--deny-list <p>] [--apply]",
  "",
  "  The monthly KPI report over the flywheel's pass receipts + claim state:",
  "  claims created vs applied, time-to-distill, pending backlog trends (distill",
  "  backlog, review queue, pending-tag), refutation rate, schema compliance.",
  "  MEASURES, never acts. Published as a dated brief in the vault's briefs area,",
  "  period-keyed (health-YYYY-MM.md) — idempotent per period. Dry-run by",
  "  default; --apply writes the brief and (with --jobs) the pass receipt.",
  "",
  "  --dashboards is required (the receipts journal is the report's primary",
  "  input). --jobs names the Notturno job registry (receipt filing; the env",
  "  fallback is AMICO_NOTTURNO_REGISTRY); a deny-listed registry is refused",
  "  loudly (64) — org config runs through the private instance's runner.",
].join("\n");

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: BRAIN_HEALTH_JOB, error, usage: USAGE, ...extra }, code: 64 };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function brainHealthVerb(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => Date } = {},
): Promise<VerbResult> {
  const now = deps.now ?? (() => new Date());
  const valuedFlags = [
    "--period",
    "--dashboards",
    "--registry",
    "--candidates",
    "--state",
    "--queue",
    "--meetings",
    "--out",
    "--briefs",
    "--jobs",
    "--deny-list",
  ];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name === "--apply") {
      apply = true;
      continue;
    }
    if (!valuedFlags.includes(name)) return fail(`unexpected argument "${name}"`);
    if (argv[i + 1] === undefined) return fail(`flag "${name}" needs a value`);
    i++;
  }

  // ── resolve the report's window ─────────────────────────────────────────
  const period = flagValue(argv, "--period") ?? now().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return fail(`--period must be YYYY-MM (a calendar month), got "${period}" — the report windows receipts and history on it, never a guess`);
  }

  // ── resolve the substrates (every path explicit or mount-defaulted) ─────
  const mount = personalMount(resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML));
  const dashboards = flagValue(argv, "--dashboards");
  if (dashboards === undefined)
    return fail("brain-health needs its journal: pass --dashboards <dir|file> (the scheduled-passes.md receipts are the report's primary input)");

  const registry = flagValue(argv, "--registry") ?? (mount !== undefined ? join(mount.path, "amicode", "claims") : undefined);
  if (registry === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  if (!existsSync(registry))
    return fail(`claims registry not found: ${registry} (missing is a typo or nothing projected yet — the report never guesses a substrate)`);

  const journal = dashboards.endsWith(".md") ? dashboards : join(dashboards, "scheduled-passes.md");
  if (!existsSync(journal)) return fail(`receipts journal not found: ${journal} (no receipts → no report — never an invented one)`);

  const candidates = flagValue(argv, "--candidates") ?? (mount !== undefined ? join(registry, "candidates") : undefined);
  const statePath = flagValue(argv, "--state") ?? join(amicodeOpsDir(env), "distill-state.json");
  const queueFile = flagValue(argv, "--queue") ?? join(dirname(registry), "review-queue.md");
  const meetingsRoot = flagValue(argv, "--meetings");

  const briefPath =
    flagValue(argv, "--out") ??
    join(flagValue(argv, "--briefs") ?? (mount !== undefined ? join(mount.path, "briefs") : undefined) ?? ".", `health-${period}.md`);
  if (flagValue(argv, "--out") === undefined && mount === undefined && flagValue(argv, "--briefs") === undefined)
    return fail("no personal vault mount resolved — pass --out <file> or --briefs <dir> explicitly (the briefs area is never a guess)");

  // ── the chassis deny gate fires BEFORE any body work ────────────────────
  const jobs = flagValue(argv, "--jobs") ?? env.AMICO_NOTTURNO_REGISTRY;
  if (jobs !== undefined && jobs !== "") {
    const denied = triageDenyGate(BRAIN_HEALTH_JOB, jobs, flagValue(argv, "--deny-list"));
    if (denied !== undefined) return denied;
  }

  // ── read every substrate (READ-ONLY; the report measures, never acts) ────
  const parsedJournal = parsePasses(readFileSync(journal, "utf8"));
  const { claims, skipped: skippedClaims } = loadRegistryClaims(registry);
  const { stamps: candidatesStamps, skipped: skippedCandidates } =
    candidates !== undefined ? loadCandidateStamps(candidates) : { stamps: [], skipped: [] };
  const queue = readReviewQueueCount(queueFile);
  const meetings = meetingsRoot !== undefined ? countPendingTagMeetings(meetingsRoot) : { count: null };
  const distill_stamped = existsSync(statePath) ? Object.keys(readDistillState(statePath).entries).length : null;

  const report = computeHealthReport({
    period,
    receipts: parsedJournal.receipts,
    claims,
    candidates: candidatesStamps,
    review_queue: queue.count,
    pending_tag: meetings.count,
    distill_stamped,
  });
  // the loaders' findings ride the report's own never-silent surface
  const findings = [
    ...parsedJournal.findings.map((f) => `journal: ${f}`),
    ...skippedClaims.map((f) => `registry: ${f}`),
    ...skippedCandidates.map((f) => `candidates: ${f}`),
    ...(queue.finding !== undefined ? [queue.finding] : []),
    ...(meetings.finding !== undefined ? [meetings.finding] : []),
    ...(distill_stamped === null ? [`no distill state stamp at ${statePath} — the distill backlog's stamped side is unmeasured`] : []),
    ...report.findings,
  ];
  const brief = renderHealthBrief({ ...report, findings }, { generated_at: now().toISOString() });

  const base = {
    verb: BRAIN_HEALTH_JOB,
    ok: true,
    dry_run: !apply,
    period,
    journal,
    registry,
    brief_path: briefPath,
    kpis: { ...report, findings },
  };

  // dry-run is REPORT-ONLY: no brief, no receipt (the distill convention)
  if (!apply) return { json: { ...base, would_write: briefPath, brief }, code: 0 };

  // ── apply: the ONLY writes are the brief + (with --jobs) the receipt ─────
  mkdirSync(dirname(briefPath), { recursive: true });
  const tmp = `${briefPath}.tmp-${process.pid}`;
  writeFileSync(tmp, brief);
  renameSync(tmp, briefPath); // atomic — a crash never leaves a half-written brief

  const outcome = `brain-health: period ${period} — receipts ${report.receipts.in_period}, claims ${report.refutation.total_claims}, created ${report.created_vs_applied.created}, applied ${report.created_vs_applied.applied}, refuted ${report.refutation.refuted}, drift ${report.schema_compliance.latest_drift ?? 0} — brief ${briefPath}`;
  const receipt = triageJobReceipt(
    BRAIN_HEALTH_JOB,
    BRAIN_HEALTH_JOB,
    jobs !== undefined && jobs !== "" ? jobs : undefined,
    dashboards,
    { outcome, artifacts: [briefPath], durationMs: 0, acted: true },
    now(),
  );
  if ("error" in receipt) return receipt.error;
  return { json: { ...base, wrote: briefPath, receipt: receipt.receipt }, code: 0 };
}
