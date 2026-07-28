// The tier-1 review lenses (spec-20260728 §3.1): mechanical, free, deterministic, and
// computed from the SPEC ALONE.
//
// That last property is what makes the free-tier guarantee real rather than a policy — a
// bad spec never reaches a paid critic because nothing here needs one. Rev 1 of the spec
// had a `bounds` lens whose predicate was "the budget covers the work THE PLAN will
// need", and the plan does not exist until a frontier planner call; all three critics
// found it independently. That check now lives in `plan compile`, where the plan exists.
//
// ONE SIGNATURE, no exceptions. `status` and `findings` are separate because "ran and
// found nothing" must be distinguishable from "never ran" — collapsing them is how a
// blocking lens that could not run reads as a pass (§3.2).
import { validate, validateBounds } from "@amicode/schema";
import { isLaunchShaped, isTaskType, type Tier1Lens } from "./lens_registry.js";

export type LensStatus = "ran" | "not-applicable" | "skipped" | "unverified";

export interface Finding {
  lens: string;
  severity: "blocking" | "advisory";
  claim: string;
  evidence: string;
  /** REQUIRED. A finding that cannot say what would fix it is not actionable and is
   *  dropped — the same standard the warrant refusal holds itself to. */
  remedy: string;
  round: number;
}

export interface LensResult {
  status: LensStatus;
  findings: Finding[];
}

export interface LensDeps {
  /** Injected so `precedent` stays pure and testable. A lens must never read the ledger
   *  itself. */
  queryLedger?: (structureHash: string) => { total: number; verified: number } | undefined;
  round?: number;
}

export type Spec = Record<string, unknown>;
export type Lens = (spec: Spec, deps?: LensDeps) => LensResult;

const ran = (findings: Finding[] = []): LensResult => ({ status: "ran", findings });
const na = (): LensResult => ({ status: "not-applicable", findings: [] });

function finding(
  lens: Tier1Lens,
  severity: "blocking" | "advisory",
  claim: string,
  evidence: string,
  remedy: string,
  round = 1,
): Finding {
  return { lens, severity, claim, evidence, remedy, round };
}

/** Applies only to launch-shaped work; anything else reports not-applicable rather than a
 *  vacuous pass. */
function launchOnly(spec: Spec): boolean {
  return isTaskType(spec.task_type) && isLaunchShaped(spec.task_type);
}

// ── schema ───────────────────────────────────────────────────────────────────────
/** The whole frontmatter contract, in-process against the registered `spec` kind. */
export const schema: Lens = (spec, deps) => {
  const r = validate(spec, "spec");
  if (r.ok) return ran();
  return ran([
    finding(
      "schema",
      "blocking",
      `the spec's frontmatter does not satisfy the spec schema (${r.errors.length} error${r.errors.length === 1 ? "" : "s"})`,
      r.errors.slice(0, 6).join("; "),
      "fix the named fields; `budget` is required for launch-shaped task types and forbidden otherwise",
      deps?.round ?? 1,
    ),
  ]);
};

// ── falsifiable ──────────────────────────────────────────────────────────────────
/** `metric comparator threshold`. `metric` is an identifier, `comparator` one of
 *  < <= == >= >, `threshold` a number (optionally a percentage or scientific notation).
 *
 *  This lens is why `acceptance` and `invariants` are separate fields: Rev 2 of the spec
 *  made this blocking and then authored six prose sentences in `acceptance`, so either the
 *  parser accepted prose — a blocking lens that passes everything, the defect §3.4 names —
 *  or the spec failed its own gate. A critic caught it. */
const ACCEPTANCE = /^[A-Za-z_][A-Za-z0-9_.]*\s*(<=|>=|==|<|>)\s*-?\d+(\.\d+)?([eE][-+]?\d+)?%?$/;

export const falsifiable: Lens = (spec, deps) => {
  const entries = Array.isArray(spec.acceptance) ? (spec.acceptance as unknown[]) : [];
  const round = deps?.round ?? 1;
  if (entries.length === 0) {
    return ran([
      finding(
        "falsifiable",
        "blocking",
        "the spec declares no acceptance criteria",
        "`acceptance` is absent or empty",
        "add at least one `metric comparator threshold` entry, e.g. `F_rolled >= 0.999`",
        round,
      ),
    ]);
  }
  const bad = entries.filter((e) => !ACCEPTANCE.test(String(e).trim()));
  if (bad.length === 0) return ran();
  return ran([
    finding(
      "falsifiable",
      "blocking",
      `${bad.length} acceptance entr${bad.length === 1 ? "y is" : "ies are"} not machine-checkable`,
      bad.slice(0, 3).map((b) => `"${String(b).slice(0, 60)}"`).join(", "),
      "rewrite each as `metric comparator threshold` (e.g. `F_rolled >= 0.999`) and move behavioural prose to `invariants`",
      round,
    ),
  ]);
};

// ── budget ───────────────────────────────────────────────────────────────────────
/** The authored budget's key set must be a subset of the SHIPPED WarrantBounds. Checked
 *  against the schema file via validateBounds, never against a prose restatement — the
 *  drift that let the long-removed `max_duration` into a spec example. */
export const budget: Lens = (spec, deps) => {
  if (!launchOnly(spec)) return na();
  const round = deps?.round ?? 1;
  const b = spec.budget;
  if (b === undefined || b === null) {
    return ran([
      finding(
        "budget",
        "blocking",
        "launch-shaped work declares no budget, so an approval would have no bounds to grant",
        `task_type is "${String(spec.task_type)}"`,
        "add `budget` with the bounds this work needs (max_solves, tier, max_size_class, device)",
        round,
      ),
    ]);
  }
  const r = validateBounds(b);
  if (r.ok) return ran();
  return ran([
    finding(
      "budget",
      "blocking",
      "the budget declares a bound the warrant vocabulary does not have",
      r.errors.slice(0, 4).join("; "),
      "use only max_solves, tier, max_size_class and device — max_duration was removed because nothing estimates wall-clock, so it could never be enforced",
      round,
    ),
  ]);
};

// ── baseline ─────────────────────────────────────────────────────────────────────
/** Either a number WITH its source, or an explicit statement that none exists. Blocking
 *  precisely so "we never checked" cannot pass silently: a bare fidelity is
 *  uninterpretable without knowing what the free baseline was. */
export const baseline: Lens = (spec, deps) => {
  if (!launchOnly(spec)) return na();
  const round = deps?.round ?? 1;
  const b = spec.baseline as Record<string, unknown> | undefined;
  const hasValue = b !== undefined && b !== null && typeof b.value === "number" && typeof b.source === "string";
  const hasNone = b !== undefined && b !== null && typeof b.none_because === "string" && b.none_because !== "";
  if (hasValue || hasNone) return ran();
  return ran([
    finding(
      "baseline",
      "blocking",
      "the spec states nothing to measure the result against",
      b === undefined ? "`baseline` is absent" : `\`baseline\` is ${JSON.stringify(b).slice(0, 80)}`,
      "add `baseline: {value, source}`, or `baseline: {none_because: '…'}` if no prior art exists",
      round,
    ),
  ]);
};

// ── precedent ────────────────────────────────────────────────────────────────────
/** Prior attempts at this work identity. Turns the existing ledger into a free critic
 *  that can say "you attempted this three times; one verified".
 *
 *  Reports NOT-APPLICABLE without a declared work identity, which is a different claim
 *  from "no prior attempts". Rev 1 of the spec would have reported a silent zero — which
 *  also makes the "block at >= 3 failures" threshold meaningless. */
export const precedent: Lens = (spec, deps) => {
  if (!launchOnly(spec)) return na();
  const round = deps?.round ?? 1;
  const sh = spec.structure_hash;
  if (typeof sh !== "string" || sh === "") return na();
  const q = deps?.queryLedger?.(sh);
  if (q === undefined) return { status: "unverified", findings: [] };
  if (q.total === 0) return ran();
  return ran([
    finding(
      "precedent",
      "advisory",
      `this work identity has ${q.total} prior attempt${q.total === 1 ? "" : "s"} on record, ${q.verified} verified`,
      `structure_hash ${sh.slice(0, 12)}…`,
      q.verified === 0
        ? "no prior attempt verified — say what is different this time, or warm-start from the closest one"
        : "consider warm-starting from the verified attempt rather than cold-starting",
      round,
    ),
  ]);
};

// ── provenance ───────────────────────────────────────────────────────────────────
/** A declared baseline VALUE must name its source. Concrete and checkable, unlike Rev 1's
 *  "every cited number names a source", which had no checkable subject. */
export const provenance: Lens = (spec, deps) => {
  const round = deps?.round ?? 1;
  const b = spec.baseline as Record<string, unknown> | undefined;
  if (b === undefined || b === null || typeof b.value !== "number") return ran();
  if (typeof b.source === "string" && b.source !== "") return ran();
  return ran([
    finding(
      "provenance",
      "advisory",
      "the baseline states a number with no source",
      `baseline.value = ${String(b.value)}`,
      "name where the number comes from — a published reference, a vault note, or a run id",
      round,
    ),
  ]);
};

export const LENSES: Record<Tier1Lens, Lens> = {
  schema,
  falsifiable,
  budget,
  baseline,
  precedent,
  provenance,
};
