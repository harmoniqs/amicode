// lifecycle.ts — the nightly lifecycle pass (amicode #1684, brain flywheel
// slice 5 — dedupe + lifecycle): the same-claim detector (merge, evidence
// accumulation, BOTH provenance trails preserved on the older claim), the
// status transitions through the append-only history (corroborate at the
// evidence threshold, refute on a contradicted-by-run signal), and the decay
// review queue.
//
// DOCTRINE (#1679 / #1684 Key Decisions):
//   - Merging preserves the OLDER claim's identity (statement, status,
//     confidence, scope) and accumulates everything else: evidence, tags,
//     adoption counts, and the duplicate's own history trail — appended, never
//     rewritten (the schema's append-only wording, kept literally).
//   - Decay PROPOSES, humans dispose: the queue is a rendered proposal
//     surface. The pass never deletes a claim on decay and never changes a
//     status on decay — the only status moves are the corroborate/refute
//     transitions, each stamped with a history entry from the pinned
//     vocabulary (slice 2's CLAIM_HISTORY_EVENTS — never a parallel set).
//   - Status never changes silently: every transition appends history; every
//     refusal is a named finding (an unacted signal, an unageable claim).
//   - The pass is a PURE core: claims in (the slice-3 loadRegistryClaims
//     shape), a passed-in clock, claims + actions out. It clones its input;
//     the verb owns every byte written to disk.
//   - Adoption fields (applied / last_applied) are READ here (the decay
//     window's clock) but never STAMPED — stamping is #1683's slice; the
//     merge accumulates what both claims already carried.
import { stringify as stringifyYaml } from "yaml";
import type { RegistryClaim } from "./claims.js";

// ── the pinned defaults (each caller-tunable in opts, pinned by test) ─────────

/** The pooled statement+tags similarity a pair must clear to be the same
 *  claim. The statement dominates (0.8) and tags refine (0.2) — identical
 *  statements with disjoint tags still merge; identical tags alone never do. */
export const MERGE_THRESHOLD = 0.75;
const STATEMENT_WEIGHT = 0.8;
const TAG_WEIGHT = 0.2;

/** Distinct evidence pointers that carry an unverified claim to corroborated. */
export const CORROBORATE_THRESHOLD = 3;

/** Days without adoption (never applied → since last lifecycle activity;
 *  applied → since last_applied) before a claim is proposed for review. */
export const DECAY_WINDOW_DAYS = 90;

// ── the same-claim detector (AC 1) ─────────────────────────────────────────────

/** Normalize a statement into its comparison tokens: case-folded, punctuation
 *  stripped (hyphenated compounds stay whole — "two-qubit" is one token). */
function statementTokens(statement: string): Set<string> {
  return new Set(
    statement
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((t) => t !== ""),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // vacuous agreement — both carry nothing
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity over statement + tags ∈ [0,1] — the same-claim signal. Pure and
 *  symmetric; type and scope are NOT part of the score (they are merge
 *  candidacy preconditions — see below). */
export function claimSimilarity(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const stmt = jaccard(statementTokens(String(a.statement ?? "")), statementTokens(String(b.statement ?? "")));
  const tagsOf = (claim: Record<string, unknown>): Set<string> =>
    new Set((Array.isArray(claim.tags) ? (claim.tags as unknown[]) : []).map((t) => String(t).toLowerCase()));
  return STATEMENT_WEIGHT * stmt + TAG_WEIGHT * jaccard(tagsOf(a), tagsOf(b));
}

// ── the pass's vocabulary (history events, statuses) ──────────────────────────

type HistoryEntry = { date: string; event: string; note: string };

function historyOf(claim: Record<string, unknown>): HistoryEntry[] {
  return Array.isArray(claim.history) ? structuredClone(claim.history as HistoryEntry[]) : [];
}

/** When the claim came into being — its earliest history date. The OLDER
 *  claim survives a merge; a tie breaks to the lexicographically smaller
 *  file name (deterministic survivor, pinned by test). */
function birthInstant(entry: RegistryClaim): number {
  const dates = historyOf(entry.claim)
    .map((h) => Date.parse(h.date))
    .filter((d) => Number.isFinite(d));
  return dates.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...dates);
}

function survives(a: RegistryClaim, b: RegistryClaim): RegistryClaim {
  const ba = birthInstant(a);
  const bb = birthInstant(b);
  if (ba !== bb) return ba < bb ? a : b;
  return a.file < b.file ? a : b;
}

/** Merge-candidacy: the same claim must be the same KIND of knowledge at the
 *  same ladder rung — identical statements across types or scopes never merge
 *  (a hazard is not an insight; personal is not team). */
function mergeCandidates(a: RegistryClaim, b: RegistryClaim): boolean {
  return a.claim.type === b.claim.type && a.claim.scope === b.claim.scope;
}

// ── the pass's result shape ───────────────────────────────────────────────────

/** One dedupe-merge: the surviving file, the removed file, and the pointers
 *  the survivor gained. */
export interface MergeAction {
  kind: "merge";
  survivor: string;
  duplicate: string;
  similarity: number;
  added_evidence: string[];
}

/** One status transition, stamped with the history note it appended. */
export interface Transition {
  kind: "corroborate" | "refute";
  file: string;
  from: string;
  to: string;
  note: string;
}

/** One decay review proposal — a queue entry, never a mutation. */
export interface QueueEntry {
  file: string;
  statement: string;
  type: string;
  status: string;
  confidence: string;
  applied: number;
  last_applied: string | null;
  age_days: number;
  reason: string;
}

/** A contradicted-by-run signal: the run that contradicts, the claim it
 *  contradicts (registry file name), and why. The pass's ONLY refutation
 *  input — refutation is never a guess. */
export interface ContradictionSignal {
  claim: string;
  run: string;
  note?: string;
}

export interface LifecycleOpts {
  /** the pass's clock — the caller's, never this module's */
  now: Date;
  /** contradicted-by-run signals (default: none — no refutations) */
  signals?: ContradictionSignal[];
  mergeThreshold?: number;
  corroborateThreshold?: number;
  decayWindowDays?: number;
}

export interface LifecycleResult {
  /** the post-pass claims: survivors updated, duplicates removed (a clone —
   *  the caller's objects are never mutated) */
  claims: RegistryClaim[];
  merges: MergeAction[];
  transitions: Transition[];
  queue: QueueEntry[];
  /** every refusal + every unactable input, named — the pass is never silent */
  findings: string[];
}

// ── the pass ──────────────────────────────────────────────────────────────────

export function runLifecyclePass(input: RegistryClaim[], opts: LifecycleOpts): LifecycleResult {
  const now = opts.now.toISOString();
  const mergeThreshold = opts.mergeThreshold ?? MERGE_THRESHOLD;
  const corroborateThreshold = opts.corroborateThreshold ?? CORROBORATE_THRESHOLD;
  const decayWindowDays = opts.decayWindowDays ?? DECAY_WINDOW_DAYS;

  const claims: RegistryClaim[] = input.map((c) => ({ file: c.file, claim: structuredClone(c.claim) }));
  const merges: MergeAction[] = [];
  const findings: string[] = [];

  // (1) dedupe-merge, to a fixpoint: each pass merges one pair, then rescans —
  // a merged claim may itself match a third (the cascade), and the loop ends
  // only when no pair clears the threshold (the idempotence guarantee).
  let merged = true;
  while (merged) {
    merged = false;
    scan: for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i]!;
        const b = claims[j]!;
        if (!mergeCandidates(a, b)) continue;
        const similarity = claimSimilarity(a.claim, b.claim);
        if (similarity < mergeThreshold) continue;
        const survivor = survives(a, b);
        const duplicate = survivor === a ? b : a;
        // snapshot BEFORE the union — what the survivor is about to gain
        const addedEvidence = (duplicate.claim.evidence as string[]).filter((p) => !(survivor.claim.evidence as string[]).includes(p));
        mergeInto(survivor, duplicate, now);
        claims.splice(claims.indexOf(duplicate), 1);
        merges.push({
          kind: "merge",
          survivor: survivor.file,
          duplicate: duplicate.file,
          similarity,
          added_evidence: addedEvidence,
        });
        merged = true;
        break scan;
      }
    }
  }

  // (2) refutation — the signals, before corroboration (a claim contradicted
  // this pass is never also corroborated this pass).
  const transitions: Transition[] = [];
  const byFile = new Map(claims.map((c) => [c.file, c]));
  for (const signal of opts.signals ?? []) {
    const target = byFile.get(signal.claim);
    if (target === undefined) {
      findings.push(`signal names claim "${signal.claim}" — no such claim in the registry`);
      continue;
    }
    const status = target.claim.status as string;
    if (status === "refuted" || status === "superseded") {
      findings.push(`${target.file}: contradicted-by-run signal on a ${status} claim — no-op (the claim is already terminal)`);
      continue;
    }
    if ((target.claim.evidence as string[]).length === 0) {
      // refusing keeps the registry lint-clean (#1681's invariant: zero
      // evidence cannot sit past unverified) — the human refutes by hand.
      findings.push(
        `${target.file}: refused to refute a zero-evidence claim (the registry invariant: zero evidence cannot sit past unverified) — add evidence or refute by hand`,
      );
      continue;
    }
    const note = `contradicted by run ${signal.run}${signal.note ? ` — ${signal.note}` : ""} (stamped by amico claims lifecycle, amicode #1684)`;
    target.claim.status = "refuted";
    (target.claim.history as HistoryEntry[]).push({ date: now, event: "refuted", note });
    transitions.push({ kind: "refute", file: target.file, from: status, to: "refuted", note });
  }

  // (3) corroboration — distinct evidence pointers crossing the threshold.
  for (const c of claims) {
    if (c.claim.status !== "unverified") continue; // corroborated stays; terminal never moves
    const distinct = new Set(c.claim.evidence as string[]).size;
    if (distinct < corroborateThreshold) continue;
    const note = `evidence crossed the corroboration threshold (${distinct} distinct evidence pointers ≥ ${corroborateThreshold}) (stamped by amico claims lifecycle, amicode #1684)`;
    const from = c.claim.status as string;
    c.claim.status = "corroborated";
    (c.claim.history as HistoryEntry[]).push({ date: now, event: "corroborated", note });
    transitions.push({ kind: "corroborate", file: c.file, from, to: "corroborated", note });
  }

  // (4) decay — the review queue: unapplied beyond the window, PROPOSED only.
  const queue: QueueEntry[] = [];
  const windowMs = decayWindowDays * 86_400_000;
  for (const c of claims) {
    const status = c.claim.status as string;
    if (status !== "unverified" && status !== "corroborated") continue; // terminal knowledge is out of the review economy
    const lastApplied = typeof c.claim.last_applied === "string" ? Date.parse(c.claim.last_applied) : Number.NaN;
    const historyDates = historyOf(c.claim)
      .map((h) => Date.parse(h.date))
      .filter((d) => Number.isFinite(d));
    const applied = typeof c.claim.applied === "number" ? c.claim.applied : 0;
    // adoption is the axis: a claim last adopted long ago ages from last_applied;
    // a never-applied claim ages from its newest lifecycle activity.
    const ref = Number.isFinite(lastApplied) ? lastApplied : historyDates.length === 0 ? undefined : Math.max(...historyDates);
    if (ref === undefined) {
      findings.push(`${c.file}: no parseable timestamp to age from (last_applied null, no dated history) — skipped, never guessed`);
      continue;
    }
    const ageDays = Math.floor((opts.now.getTime() - ref) / 86_400_000);
    if (ageDays <= decayWindowDays) continue;
    queue.push({
      file: c.file,
      statement: c.claim.statement as string,
      type: c.claim.type as string,
      status,
      confidence: c.claim.confidence as string,
      applied,
      last_applied: typeof c.claim.last_applied === "string" ? c.claim.last_applied : null,
      age_days: ageDays,
      reason:
        applied > 0
          ? `applied ${applied}× but not since ${c.claim.last_applied} — ${ageDays} days beyond the ${decayWindowDays}-day window`
          : `never applied — no lifecycle activity since ${new Date(ref).toISOString()}, ${ageDays} days beyond the ${decayWindowDays}-day window`,
    });
  }

  return { claims, merges, transitions, queue, findings };
}

/** The merge: accumulate the duplicate onto the survivor. Pure append — the
 *  duplicate's own history trail rides the survivor's, then the merge stamp.
 *  The survivor's statement/status/confidence/scope ARE its identity and are
 *  untouched. */
function mergeInto(survivor: RegistryClaim, duplicate: RegistryClaim, now: string): void {
  const s = survivor.claim;
  const d = duplicate.claim;
  const union = (mine: unknown, theirs: unknown): string[] => {
    const out = Array.isArray(mine) ? [...(mine as string[])] : [];
    for (const v of Array.isArray(theirs) ? (theirs as string[]) : []) if (!out.includes(v)) out.push(v);
    return out;
  };
  const addedEvidence = (d.evidence as string[]).filter((p) => !(s.evidence as string[]).includes(p));
  s.evidence = [...(s.evidence as string[]), ...addedEvidence];
  s.tags = union(s.tags, d.tags);
  s.applied = (typeof s.applied === "number" ? s.applied : 0) + (typeof d.applied === "number" ? d.applied : 0);
  const sApplied = typeof s.last_applied === "string" ? Date.parse(s.last_applied) : Number.NaN;
  const dApplied = typeof d.last_applied === "string" ? Date.parse(d.last_applied) : Number.NaN;
  if (Number.isFinite(dApplied) && (!Number.isFinite(sApplied) || dApplied > sApplied)) s.last_applied = d.last_applied;
  const absorbed = historyOf(d);
  (s.history as HistoryEntry[]).push(
    ...absorbed,
    {
      date: now,
      event: "merged",
      note: `merged duplicate claim ${duplicate.file} ("${d.statement}") — its evidence pointers and history trail are preserved here (dedupe-merge, amicode #1684)`,
    },
  );
}

// ── the proposal surface (AC 3's queue, rendered) ──────────────────────────────

/** Render the review queue as the human proposal surface: a generated-view
 *  header (the same doctrine as the hot-layer index — derived, never
 *  authoritative) + one reviewable line per claim. Deterministic. */
export function renderQueueFile(queue: QueueEntry[], opts: { now: Date; windowDays: number }): string {
  const header = [
    "<!--",
    "generated view — `amico claims lifecycle` (amicode #1684, the brain-flywheel decay review queue)",
    "a PROPOSAL surface: the pass never deletes a claim and never changes a status on",
    "decay — humans dispose (corroborate, supersede, refute, or re-apply by hand).",
    "-->",
    "",
  ];
  if (queue.length === 0) {
    return [...header, `no claims beyond the ${opts.windowDays}-day decay window — nothing to review.`, ""].join("\n");
  }
  const title = [
    `# Claims review queue — ${queue.length} beyond the ${opts.windowDays}-day decay window`,
    "",
    `Generated ${opts.now.toISOString()} by the nightly lifecycle pass. Each entry is a`,
    "proposal for human disposal; nothing here was deleted, demoted, or restated.",
    "",
  ];
  const bullets = queue.map(
    (q) =>
      `- [${queueLabel(q.statement)}](claims/${q.file}) — ${q.type} · ${q.status} · ${q.confidence} · applied ${q.applied}× · last applied ${q.last_applied ?? "never"} — ${q.reason}`,
  );
  return [...header, ...title, ...bullets, ""].join("\n");
}

/** The queue's bullet label: the statement, bracket-escaped and truncated to a
 *  one-line pointer (the hot-layer index's bulletLabel discipline). */
function queueLabel(statement: string): string {
  const escaped = statement.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return escaped.length > 160 ? escaped.slice(0, 159) + "…" : escaped;
}

// ── the write path's seam: swap EXACTLY the frontmatter, never the prose ──────

/** Rewrite a claim note for an updated claim object: the frontmatter becomes
 *  EXACTLY the claim (the registry's ONE contract), and the body below the
 *  frontmatter block is preserved byte-for-byte — machinery never edits
 *  prose (the #1681 rendering doctrine). */
export function rewriteClaimNote(raw: string, claim: Record<string, unknown>): string {
  const block = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (block === null) throw new Error("malformed claim note: could not isolate the frontmatter block");
  const body = raw.slice(block[0].length);
  const frontmatter = stringifyYaml(claim, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n${body}`;
}
