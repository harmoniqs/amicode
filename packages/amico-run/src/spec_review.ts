// The spec-review runner (spec-20260728 §3): applicability -> lenses -> status ->
// verdict -> findings sidecar -> one `spec_review` ledger record.
//
// This module owns the only I/O in the review path; the lenses are pure and the registry
// is data. Tier 2 (frontier critics) is G-2-gated and NOT built here — but its seam is,
// because the zero-spawn guarantee is testable now and would be untestable later.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, designHash } from "@amicode/schema";
import { appendRecord, type SpecReviewRecord } from "./ledger.js";
import { parseFrontmatter } from "./frontmatter.js";
import { LENSES, type Finding, type LensStatus } from "./lenses.js";
import {
  LENS_REGISTRY_VERSION,
  criticCountFor,
  isTaskType,
  tier1LensesFor,
  tier2LensesFor,
  type Tier1Lens,
} from "./lens_registry.js";

export const ROUND_BUDGET = 3;

export type ReviewVerdict = "approved" | "approved-mechanical" | "degraded" | "blocking" | "exhausted";

export interface LensStatusEntry {
  lens: string;
  status: LensStatus;
  reason?: string;
}

export interface ReviewResult {
  review_verdict: ReviewVerdict;
  exit_code: 0 | 64 | 65 | 66;
  spec_id: string;
  design_hash: string;
  rounds: number;
  lens_status: LensStatusEntry[];
  critics: Array<{ model: string; variant: string }>;
  findings: Finding[];
  findings_count: number;
  blocking_count: number;
  findings_sha256: string;
  findings_ref: string;
  critic_spawns: number;
}

/** The tier-2 seam. Not implemented in this slice (G-2), but injected so the
 *  ZERO-SPAWN-on-tier-1-blocking guarantee is a test today rather than a promise. */
export type SpawnCritic = (lens: string) => { model: string; variant: string; findings: Finding[] } | undefined;

export interface ReviewOptions {
  round?: number;
  critics?: number;
  offline?: boolean;
  spawnCritic?: SpawnCritic;
  queryLedger?: (structureHash: string) => { total: number; verified: number } | undefined;
  now?: () => string;
  /** Skip the ledger append (tests that only care about the computation). */
  append?: boolean;
}

/** Blocking tier-1 lenses. A blocking lens that could not run yields `unverified`, and a
 *  review with any unverified BLOCKING lens must not report `approved` (§3.2) — Rev 1
 *  treated "the checker exited 0" as a pass, which is exactly how `api` would have passed
 *  everything silently. */
const BLOCKING_LENSES: readonly Tier1Lens[] = ["schema", "falsifiable", "budget", "baseline"];

const sha256hexOf = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `<spec-dir>/.review/<spec_id>-<design_hash>-r<round>.json`.
 *  Keyed on spec_id AND round, not design_hash alone: a prose-only revision (what most
 *  advisories ask for) leaves design_hash unchanged, so keying on it alone would have
 *  round 2 silently overwrite round 1's bodies while round 1's recorded sha still pointed
 *  at the file. */
export function findingsRefFor(specPath: string, specId: string, hash: string, round: number): string {
  return join(dirname(specPath), ".review", `${specId}-${hash.slice(0, 16)}-r${round}.json`);
}

export function reviewSpec(specPath: string, raw: string, opts: ReviewOptions = {}): ReviewResult {
  const round = opts.round ?? 1;
  const nowIso = (opts.now ?? (() => new Date().toISOString()))();
  const lens_status: LensStatusEntry[] = [];
  const findings: Finding[] = [];
  let critic_spawns = 0;
  const critics: Array<{ model: string; variant: string }> = [];

  // ── parse ──
  const fm = parseFrontmatter(raw);
  if (!fm.ok) {
    // A malformed spec is a blocking FINDING, not a config error: it tells the author what
    // to fix rather than implying they invoked the tool wrong.
    const f: Finding = {
      lens: "schema",
      severity: "blocking",
      claim: "the spec's frontmatter could not be read",
      evidence: fm.error,
      remedy: "open the note with a `---` fence on line 1 and a mapping of fields inside",
      round,
    };
    return finish(specPath, "unreadable-spec", "0".repeat(64), round, [{ lens: "schema", status: "ran" }], [], [f], 0, opts, nowIso);
  }
  const spec = fm.data;
  const spec_id = typeof spec.spec_id === "string" && spec.spec_id !== "" ? spec.spec_id : "unidentified-spec";
  const design_hash = designHash(spec);

  // ── tier 1 ──
  // Applicability comes from the registry; an unknown/absent task_type still gets the
  // universal lenses, because a spec that cannot name its own type is exactly the case the
  // schema lens must report on.
  const taskType = isTaskType(spec.task_type) ? spec.task_type : "converse";
  for (const name of tier1LensesFor(taskType)) {
    const r = LENSES[name](spec, { queryLedger: opts.queryLedger, round });
    lens_status.push({ lens: name, status: r.status });
    findings.push(...r.findings);
  }

  const blocking = findings.filter((f) => f.severity === "blocking");
  const unverifiedBlocking = lens_status.filter(
    (s) => s.status === "unverified" && (BLOCKING_LENSES as readonly string[]).includes(s.lens),
  );

  // ── the gate on tier 2: a bad spec NEVER reaches a paid critic ──
  if (blocking.length > 0 || unverifiedBlocking.length > 0) {
    for (const u of unverifiedBlocking) {
      findings.push({
        lens: u.lens,
        severity: "blocking",
        claim: `the blocking lens \`${u.lens}\` could not be verified`,
        evidence: u.reason ?? "the lens reported `unverified`",
        remedy: "make the lens's input available (or scope the lens out for this task type) — an unverified blocking lens is not a pass",
        round,
      });
    }
    return finish(specPath, spec_id, design_hash, round, lens_status, [], findings, 0, opts, nowIso);
  }

  // ── tier 2 ──
  const wanted = criticCountFor(taskType, opts.critics ?? 3);
  const lenses = tier2LensesFor(taskType).slice(0, wanted);
  let degraded = false;
  if (!opts.offline && opts.spawnCritic && lenses.length > 0) {
    for (const lens of lenses) {
      critic_spawns++;
      const out = opts.spawnCritic(lens);
      if (!out) {
        // Timeout, unparseable output, spawn failure: `skipped`, never counted as clean.
        lens_status.push({ lens, status: "skipped", reason: "critic did not return usable output" });
        degraded = true;
        continue;
      }
      lens_status.push({ lens, status: "ran" });
      critics.push({ model: out.model, variant: out.variant });
      // THE TERMINATION INVARIANT: a tier-2 critic may not emit `blocking` except for
      // `contradiction`. Anything else is DOWNGRADED to advisory and logged — this is what
      // guarantees the loop converges, so it is enforced rather than requested.
      for (const f of out.findings) {
        if (f.severity === "blocking" && f.lens !== "contradiction") {
          process.stderr.write(
            `amico spec review: downgraded a non-contradiction blocking finding from lens "${f.lens}" to advisory\n`,
          );
          findings.push({ ...f, severity: "advisory" });
        } else {
          findings.push(f);
        }
      }
    }
  } else if (lenses.length > 0) {
    // No critic mechanism available: tier 1 only, and the record says so.
    degraded = false;
  }

  const post = findings.filter((f) => f.severity === "blocking");
  if (post.length > 0) {
    return finish(specPath, spec_id, design_hash, round, lens_status, critics, findings, critic_spawns, opts, nowIso);
  }
  const verdict: ReviewVerdict = lenses.length === 0 || critics.length === 0
    ? "approved-mechanical"
    : degraded
      ? "degraded"
      : "approved";
  return finish(specPath, spec_id, design_hash, round, lens_status, critics, findings, critic_spawns, opts, nowIso, verdict);
}

function finish(
  specPath: string,
  spec_id: string,
  design_hash: string,
  round: number,
  lens_status: LensStatusEntry[],
  critics: Array<{ model: string; variant: string }>,
  findings: Finding[],
  critic_spawns: number,
  opts: ReviewOptions,
  nowIso: string,
  forced?: ReviewVerdict,
): ReviewResult {
  const blocking_count = findings.filter((f) => f.severity === "blocking").length;
  let review_verdict: ReviewVerdict =
    forced ?? (blocking_count > 0 ? (round >= ROUND_BUDGET ? "exhausted" : "blocking") : "approved-mechanical");
  const exit_code: 0 | 64 | 65 | 66 =
    review_verdict === "blocking" ? 65 : review_verdict === "exhausted" ? 66 : 0;

  // Findings BODIES go to a sidecar. The record carries only a digest, because a 3-round
  // 3-critic review's prose exceeds PIPE_BUF and appendRecord throws above it — AFTER the
  // model spend, losing the whole review.
  const findings_sha256 = sha256hexOf(canonicalJson(findings as never));
  const findings_ref = findingsRefFor(specPath, spec_id, design_hash, round);
  try {
    mkdirSync(dirname(findings_ref), { recursive: true });
    writeFileSync(findings_ref, JSON.stringify(findings, null, 2));
  } catch (e) {
    // LOUD, not a dangling ref: losing the bodies after spending on them is the failure
    // the sidecar exists to prevent, so it must not read as a clean review.
    throw new Error(`could not write the findings sidecar at ${findings_ref}: ${(e as Error).message}`);
  }

  const rec: SpecReviewRecord = {
    type: "spec_review",
    ts: nowIso,
    spec_id,
    design_hash,
    rounds: Math.min(Math.max(round, 1), ROUND_BUDGET),
    review_verdict,
    lens_registry_version: LENS_REGISTRY_VERSION,
    lens_status,
    critics,
    findings_count: findings.length,
    blocking_count,
    findings_sha256,
    findings_ref,
    source: "user",
  };
  if (opts.append !== false) appendRecord(rec);

  return {
    review_verdict,
    exit_code,
    spec_id,
    design_hash,
    rounds: rec.rounds,
    lens_status,
    critics,
    findings,
    findings_count: findings.length,
    blocking_count,
    findings_sha256,
    findings_ref,
    critic_spawns,
  };
}

/** Read-and-review, for the verb. Kept separate so `reviewSpec` stays testable on a string. */
export function reviewSpecFile(specPath: string, readFile: (p: string) => string, opts: ReviewOptions = {}): ReviewResult {
  if (!existsSync(specPath)) throw new Error(`spec not found: ${specPath}`);
  return reviewSpec(specPath, readFile(specPath), opts);
}
