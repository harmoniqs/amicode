// curation.ts — the pure core behind the three weekly curation jobs (amicode
// #1685, brain flywheel slice 6 — promote / prune / synthesize, the dream cycle
// employed as notturno jobs on the claim layer).
//
// DOCTRINE (#1679 / #1685 Key Decisions):
//   - Promote PROPOSES, never acts: the output is ONE promotion bundle per
//     vault — a PR-body artifact + copy-never-move claim copies — capped at
//     10, that a HUMAN merges. The double gate is the trust boundary: gate 1
//     is the author's `scope: team` tag (why a claim is eligible at all),
//     gate 2 is the human PR merge. This module renders bytes; it has no git,
//     no gh, no network — auto-merge is structurally impossible.
//   - Prune applies only UNAMBIGUOUS fixes — mechanical frontmatter hygiene
//     whose result is provably still a valid claim (duplicate evidence
//     pointers, whitespace-padded/duplicate tags). Everything else (every
//     `claims lint` finding — an invalid claim, an unresolvable pointer) is
//     DRIFT a human owns: a pointer is never "fixed" by deletion, a schema
//     disagreement is never locally re-typed (the dream-prune Step 5 rule).
//   - Synthesize proposes to the HOPPER, never to strategy: cross-claim tag
//     clusters (the dream-synthesize quality bar — 3+ independent data
//     points, high at 5+) become hopper notes with machine provenance.
//     Human-fed strategy sections are human-fed by design; this module has
//     no code path that reads or writes a strategy file at all.
//
// The curation motions retire the manual `/dream` invocation family — the
// jobs ARE the dream cycle's semantics, on cadence, receipted (docs/
// brain-flywheel-jobs.md).
//
// PURITY: no clock (now passed in), no vault/DB/git I/O beyond the promote
// state stamp helpers (explicit paths, the distill-state pattern); the
// renderers are deterministic — same inputs + same clock → identical bytes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { HOT_STATUSES, type RegistryClaim } from "./claims.js";
import { validateClaim } from "@amicode/schema";

// ── the notturno job ids (the registry's membership vocabulary) ────────────────

/** The weekly promotion job — one PR-body bundle per vault, human-merged. */
export const PROMOTE_JOB = "promote";
/** The weekly hygiene job — schema-check (the claims lint, reused) + the
 *  unambiguous-fix apply, drift flagged for a human. */
export const PRUNE_JOB = "prune";
/** The weekly pattern job — cross-claim clusters → hopper proposals. */
export const SYNTHESIZE_JOB = "synthesize";

// ── promote (AC 1) ────────────────────────────────────────────────────────────

/** The per-vault proposal cap — the dream-promote token-budget knob 2: at
 *  most 10 claims per bundle per run; overflow carries, never drops. */
export const PROMOTE_CAP = 10;

/** One proposal stamp: which bundle proposed the claim, and when. A stamped
 *  claim is out of the pool until the merged-PR writeback resolves it. */
export interface PromoteProposalStamp {
  bundle: string;
  proposed_at: string;
}

export interface PromoteState {
  schema_version: number;
  proposals: Record<string, PromoteProposalStamp>;
}

/** Read the promote state stamp. Absent or malformed reads as EMPTY —
 *  fail-safe to re-propose, never to skip (the distill-state doctrine: a
 *  corrupt stamp must never widen what is skipped). */
export function readPromoteState(path: string): PromoteState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PromoteState;
    if (parsed && typeof parsed === "object" && parsed.proposals && typeof parsed.proposals === "object") {
      return { schema_version: 1, proposals: parsed.proposals };
    }
  } catch {
    // absent/malformed → empty (fail-safe)
  }
  return { schema_version: 1, proposals: {} };
}

/** Write the state stamp ATOMICALLY (tmp + rename, the distill-state pattern). */
export function writePromoteState(path: string, state: PromoteState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Stamp files as proposed (pure — returns a new state). */
export function stampPromoted(state: PromoteState, files: string[], stamp: PromoteProposalStamp): PromoteState {
  const proposals = { ...state.proposals };
  for (const file of files) proposals[file] = stamp;
  return { schema_version: 1, proposals };
}

export interface PromotePlan {
  /** scope-team live claims not yet proposed (deterministic: file order) */
  eligible: string[];
  /** the first `cap` eligible — this bundle's proposals */
  selected: string[];
  /** the rest — carried to the next run, never dropped */
  overflow: string[];
  /** named exclusions, each with its reason — a claim is never silently dropped */
  excluded: string[];
}

/** Plan the promotion: eligible = `scope: team` AND live (the hot statuses —
 *  terminal knowledge never crosses the ladder) AND not already proposed.
 *  Public-scoped claims are excluded BY NAME (the public tier is a later
 *  slice's outer face, never this job's pool); personal claims are simply
 *  out of the pool. The cap keeps one bundle at 10; overflow carries. */
export function planPromotion(claims: RegistryClaim[], state: PromoteState, opts: { cap?: number } = {}): PromotePlan {
  const cap = opts.cap ?? PROMOTE_CAP;
  const eligible: string[] = [];
  const excluded: string[] = [];
  for (const { file, claim } of [...claims].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    if (claim.scope !== "team") {
      if (claim.scope === "public")
        excluded.push(`${file} (scope: public — the public tier is a later slice's outer face, never this job's pool)`);
      continue; // personal is simply out of the pool — no naming, no guessing
    }
    if (state.proposals[file] !== undefined) continue; // pending a human merge — out of the pool
    if (!(HOT_STATUSES as readonly string[]).includes(claim.status as string)) {
      excluded.push(`${file} (status: ${claim.status} — terminal knowledge never crosses the ladder)`);
      continue;
    }
    eligible.push(file);
  }
  return { eligible, selected: eligible.slice(0, cap), overflow: eligible.slice(cap), excluded };
}

/** The bundle id — deterministic from the caller's clock (the audit artifact's
 *  directory name; a collision means the bundle already exists, and the verb
 *  refuses rather than clobber it). */
export function promoteBundleId(now: Date): string {
  const iso = now.toISOString();
  return `promote-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** The claims table row for one selected claim. */
function prRow(entry: RegistryClaim): string {
  const c = entry.claim;
  const statement = String(c.statement).replace(/\|/g, "\\|");
  return `| \`${entry.file}\` | ${statement} | ${c.type} | ${c.status} | ${c.confidence} | ${c.applied}× |`;
}

/** Render the promotion bundle's PR body — the PROPOSAL artifact a human
 *  merges. Carries the double gate, the dream-promote branch convention, one
 *  row per proposed claim, the carried overflow, and the exact human-run
 *  steps. Deterministic. */
export function renderPrBody(
  plan: PromotePlan,
  claims: RegistryClaim[],
  meta: { sourceVault: string; bundleId: string; now: Date },
): string {
  const date = meta.now.toISOString().slice(0, 10);
  const byFile = new Map(claims.map((c) => [c.file, c]));
  const rows = plan.selected.map((file) => byFile.get(file)).filter((c): c is RegistryClaim => c !== undefined).map(prRow);
  return [
    "<!--",
    "generated view — `amico claims promote` (amicode #1685, brain flywheel slice 6)",
    "a PROPOSAL, never an action: this verb never opens a PR, never merges, never",
    "pushes. The double gate is the trust boundary — gate 1 is the author tagging",
    "`scope: team` on each claim (already done; that is why they are here); gate 2 is",
    "a HUMAN reviewing this bundle and merging it by hand. The bundle is the audit",
    "artifact: nothing has left the source vault until a human opens the PR.",
    "-->",
    "",
    `# promote: ${meta.sourceVault} → armonissima (${plan.selected.length} claims, ${date})`,
    "",
    `Bundle \`${meta.bundleId}\` — proposed ${meta.now.toISOString()} by the weekly promote job`,
    `(notturno job id \`promote\`, amicode #1685). Branch: \`promote/${meta.sourceVault}\` (the`,
    "dream-promote branch convention — the merged-PR writeback matches it). cap: 10",
    "claims per bundle; overflow carries to the next run, never drops a claim.",
    "",
    `## Proposed claims (${plan.selected.length})`,
    "",
    "| claim | statement | type | status | confidence | applied |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `## Overflow (carried to the next run): ${plan.overflow.length}`,
    ...(plan.overflow.length === 0
      ? ["none — every eligible claim fit under the cap"]
      : plan.overflow.map((f) => `- \`${f}\``)),
    "",
    "## What a human does next (gate 2 — the only path to armonissima)",
    "",
    "1. Review the table; drop any claim that should not leave the vault by deleting",
    "   its copy from this bundle.",
    `2. In the armonissima checkout: \`git checkout -b promote/${meta.sourceVault}\` (reuse the`,
    "   branch from a prior unmerged run if it exists).",
    "3. Copy each remaining claim file from this bundle into `amicode/claims/`.",
    `4. Commit, push, and open the PR: \`gh pr create --repo harmoniqs/armonissima --base main --title "promote: ${meta.sourceVault} → armonissima (${plan.selected.length} claims, ${date})" --body-file PR-BODY.md\`.`,
    "5. Only AFTER the merge does anything change downstream — stamping the source",
    "   claims is a later, merged-PR-driven writeback (dream-promote Step 1), never",
    "   this verb's.",
    "",
    "Excluded from this proposal (named, never silently dropped):",
    ...(plan.excluded.length === 0 ? ["- none"] : plan.excluded.map((e) => `- ${e}`)),
    "",
  ].join("\n");
}

/** Render one promotion copy: the claim note VERBATIM (the frontmatter IS the
 *  claim object — untouched, the ONE contract survives promotion) + a
 *  provenance footer. Copy-never-move: the source claim stays. */
export function renderPromotionCopy(
  raw: string,
  meta: { file: string; sourceVault: string; bundleId: string; now: Date },
): string {
  return [
    raw.replace(/\n+$/, ""),
    "",
    "## Provenance",
    "",
    `Promoted by \`amico claims promote\` (amicode #1685) on ${meta.now.toISOString().slice(0, 10)} —`,
    `bundle \`${meta.bundleId}\`, copy-never-move from ${meta.sourceVault}'s claims registry`,
    `(\`amicode/claims/${meta.file}\`). The source claim stays where it is; a human merges`,
    "this bundle (the double gate: the author's scope tag + the human PR merge).",
    "",
  ].join("\n");
}

// ── prune (AC 2) ───────────────────────────────────────────────────────────────

/** One unambiguous hygiene fix — a field, its before, its after, and why it
 *  is provably safe (the fixed claim still passes the ONE contract). */
export interface PruneFix {
  file: string;
  field: "evidence" | "tags";
  from: string[];
  to: string[];
  reason: string;
}

/** Plan the hygiene pass over VALID claims (the lint stays the registry's
 *  gate — a broken note is drift, never a fix target): the two unambiguous
 *  fix classes, applied in place to a CLONE (the caller's objects are never
 *  mutated). Everything the pass will not touch is simply not in `fixes`. */
export function planPrune(claims: RegistryClaim[]): { fixes: PruneFix[]; claims: RegistryClaim[] } {
  const fixes: PruneFix[] = [];
  const out: RegistryClaim[] = claims.map((c) => ({ file: c.file, claim: structuredClone(c.claim) }));
  for (const entry of out) {
    const evidence = entry.claim.evidence as string[];
    const dedupedEvidence = [...new Set(evidence)];
    if (dedupedEvidence.length !== evidence.length) {
      fixes.push({
        file: entry.file,
        field: "evidence",
        from: evidence,
        to: dedupedEvidence,
        reason: "duplicate evidence pointers removed (order preserved)",
      });
      entry.claim.evidence = dedupedEvidence;
    }
    const tags = entry.claim.tags as string[];
    const seen = new Set<string>();
    const normalized = tags
      .map((t) => t.trim())
      .filter((t) => {
        if (t === "" || seen.has(t)) return false;
        seen.add(t);
        return true;
      });
    if (normalized.length !== tags.length || normalized.some((t, i) => t !== tags[i])) {
      fixes.push({
        file: entry.file,
        field: "tags",
        from: tags,
        to: normalized,
        reason: "whitespace-padded and duplicate tags normalized",
      });
      entry.claim.tags = normalized;
    }
    // the contract survives hygiene — a fix that would invalidate the claim
    // is a bug in this module, so it is asserted here, not assumed
    if (!validateClaim(entry.claim).ok) throw new Error(`prune fix produced an invalid claim for ${entry.file}`);
  }
  return { fixes, claims: out };
}

/** Render the hygiene diff — one line per unambiguous fix, before → after. */
export function renderPruneDiff(fixes: PruneFix[]): string {
  if (fixes.length === 0)
    return "## Hygiene diff — no unambiguous fixes (the registry's frontmatter is already clean)\n";
  const quoted = (values: string[]) => `[${values.map((v) => `"${v}"`).join(", ")}]`;
  return [
    `## Hygiene diff — ${fixes.length} unambiguous fix${fixes.length === 1 ? "" : "es"}`,
    "",
    ...fixes.map((f) => `- ${f.file}: ${f.field} — ${f.reason}: ${quoted(f.from)} → ${quoted(f.to)}`),
    "",
  ].join("\n");
}

// ── synthesize (AC 3) ─────────────────────────────────────────────────────────

/** The dream-synthesize quality bar: a pattern needs 3+ independent data
 *  points (prescriptive insights at 3+; nothing fires below it). */
export const SYNTHESIZE_MIN_POINTS = 3;

/** Patterns per run — the hopper is never flooded; the rest carries. */
export const SYNTHESIZE_CAP = 5;

/** One cross-claim pattern: a tag carried by enough LIVE claims to be worth a
 *  human's triage. Terminal claims never feed a pattern (refuted knowledge is
 *  out of the synthesis economy — the hot-layer doctrine). */
export interface ClaimPattern {
  tag: string;
  files: string[];
  types: string[];
  points: number;
  confidence: "high" | "medium";
  cross_cutting: boolean;
}

export interface PatternPlan {
  patterns: ClaimPattern[];
  /** tags whose patterns did not fit the per-run cap — carried, never dropped */
  overflow: string[];
}

/** Detect cross-claim patterns: tag clusters over the LIVE claims, at the
 *  3-point bar (high at 5+). A cluster spanning ≥2 types is cross-cutting —
 *  the "no single session would see this" signal. Deterministic: tags and
 *  files sorted, the cap applied after the sort. */
export function detectPatterns(claims: RegistryClaim[], opts: { minPoints?: number } = {}): PatternPlan {
  const minPoints = opts.minPoints ?? SYNTHESIZE_MIN_POINTS;
  const clusters = new Map<string, { file: string; type: string }[]>();
  for (const { file, claim } of claims) {
    if (!(HOT_STATUSES as readonly string[]).includes(claim.status as string)) continue;
    for (const raw of claim.tags as string[]) {
      const tag = raw.trim().toLowerCase();
      if (tag === "") continue;
      const cluster = clusters.get(tag) ?? [];
      if (cluster.some((e) => e.file === file)) continue; // one claim counts once per tag
      cluster.push({ file, type: claim.type as string });
      clusters.set(tag, cluster);
    }
  }
  const patterns: ClaimPattern[] = [];
  for (const [tag, entries] of [...clusters].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entries.length < minPoints) continue;
    const types = [...new Set(entries.map((e) => e.type))].sort();
    patterns.push({
      tag,
      files: entries.map((e) => e.file).sort(),
      types,
      points: entries.length,
      confidence: entries.length >= 5 ? "high" : "medium",
      cross_cutting: types.length >= 2,
    });
  }
  return { patterns: patterns.slice(0, SYNTHESIZE_CAP), overflow: patterns.slice(SYNTHESIZE_CAP).map((p) => p.tag) };
}

/** The hopper note's slug — the deterministic idempotency key (an existing
 *  note means the pattern is already proposed; the run skips it). */
export function hopperSlug(tag: string): string {
  return `synthesize-${tag.trim().toLowerCase()}.md`;
}

/** Render the hopper proposal note: the hopper skill's frontmatter schema,
 *  the pattern as context, the claims as evidence — and the trust boundary in
 *  prose: this proposal never writes strategy. Deterministic. */
export function renderHopperNote(pattern: ClaimPattern, meta: { now: Date }): string {
  const frontmatter = stringifyYaml(
    {
      type: "hopper",
      date: meta.now.toISOString().slice(0, 10),
      source: "internal",
      platform: "general",
      tags: [pattern.tag, "synthesis", "claims"],
      status: "proposed",
      promoted_to: null,
      held_until: null,
    },
    { lineWidth: 0 },
  ).trimEnd();
  const span = pattern.cross_cutting
    ? `across ${pattern.types.length} types (${pattern.types.join(", ")})`
    : `all of type ${pattern.types.join(", ")}`;
  return [
    "---",
    frontmatter,
    "---",
    "",
    `# Cross-claim pattern: "${pattern.tag}"`,
    "",
    "<!--",
    "generated view — `amico claims synthesize` (amicode #1685, brain flywheel slice 6,",
    "notturno job id `synthesize`): a mechanical cross-claim pattern proposal. The hopper",
    "is the only destination — this job never writes strategy (the human-fed sections",
    "are human-fed by design; a human curates hopper items into strategy at triage).",
    "-->",
    "",
    "## Context",
    "",
    `A mechanical pattern over the claims registry: **${pattern.points} live claims** ${span}`,
    `carry the tag \`${pattern.tag}\`. No single session would see this — the claims were`,
    "distilled or projected from different sources.",
    "",
    `Confidence: ${pattern.confidence} (${pattern.points} data points; the quality bar is 3+, high at 5+).`,
    "",
    "## Evidence",
    "",
    ...pattern.files.map((f) => `- ../amicode/claims/${f}`),
    "",
    "## Proposed Approach",
    "",
    "Triage per the hopper protocol (promote to strategy / promote to spec / hold /",
    "discard). If the pattern is worth pursuing, the next step is a hypothesis claim or",
    "a research brief — this proposal never writes strategy.",
    "",
    "## Overlap with Existing Strategy",
    "",
    "None asserted — this proposal does not read or touch strategy; a human curates",
    "any overlap during triage.",
    "",
    "## Open Questions",
    "",
    "1. Is the shared tag an artifact of tagging style or a real common cause?",
    "2. Do the cited claims corroborate each other (lifecycle), or merely co-occur?",
    "",
  ].join("\n");
}
