// Capability-warrant resolution and bound checking (spec-20260727-164748 §5.1).
//
// PURE by design — no fs, no clock, no ledger read. `now` and the approval rows are
// parameters, so the whole §5.1 matrix is unit-testable without a Julia process or a
// temp ledger. gate.ts does the I/O and calls in.
//
// The one asymmetry everything rests on: an absent `plan_hash`, or a bound the
// warrant omits, may only ever RESTRICT a launch — never widen it. Concretely:
//
//   rule 1 (no plan_hash)  → allowed ONLY if the launch is entirely inside the
//                            ungated free set. That is what makes the field's
//                            absence safe rather than a bypass.
//   rule 2 (plan_hash)     → every capability the launch reaches for must be
//                            DECLARED and satisfied by a live warrant. A bound the
//                            launch needs but the warrant omits is a REFUSAL, not a
//                            default-allow.
//
// Threat model is drift, not an adversary (spec §3), so no signature is verified
// here. See spec §6 for what that does and does not buy.
import type { ApprovalRecord, PlanCompiledRecord, WarrantBounds } from "./ledger.js";

export type SizeClass = "SMALL" | "MEDIUM";
export type DeviceAccess = "none" | "ro" | "rw";

/** What the gate knows about the launch in front of it. */
export interface LaunchFacts {
  plan_hash?: string;
  tier?: string;
  executor?: string;
  /** From estimate.ts. UNDEFINED means unresolved, which is treated as
   *  over-threshold (§4.4) — never as SMALL. */
  sizeClass?: SizeClass;
  device?: DeviceAccess;
  /** Solves already recorded against this warrant, for the max_solves bound. */
  solvesSoFar?: number;
}

export interface WarrantRefusal {
  ok: false;
  /** One line, naming the class, the offending bound, and its margin. */
  reason: string;
  /** The bound keys a covering warrant would have to declare — spec §5.2's third
   *  element, and the payload G-9 leans on to derive an approval request. */
  required: string[];
  /** Echoed so a caller can join the refusal to the plan it needs. */
  plan_hash?: string;
}

export type WarrantCheck = { ok: true } | WarrantRefusal;

const SIZE_ORDER: Record<SizeClass, number> = { SMALL: 0, MEDIUM: 1 };
/** Exported because `plan_compile.ts` joins step device demands under the SAME order the
 *  launch gate compares with. Restating `{none:0,ro:1,rw:2}` in a second module would let the
 *  two drift, which is the defect class this spec keeps reproducing — one authority, imported. */
export const DEVICE_ORDER: Record<DeviceAccess, number> = { none: 0, ro: 1, rw: 2 };

/** Expiry in ms. An unparseable expiry is ALREADY EXPIRED — a warrant whose
 *  lifetime cannot be established must not read as live (same fail-closed direction
 *  as §4.4's estimator inversion). */
function expiryMs(w: ApprovalRecord): number {
  const t = Date.parse(w.expires_at);
  return Number.isNaN(t) ? -Infinity : t;
}

/** The live warrant for `planHash` expiring latest, or undefined if none is live. */
export function liveWarrant(
  planHash: string,
  approvals: readonly ApprovalRecord[],
  now: number,
): ApprovalRecord | undefined {
  let best: ApprovalRecord | undefined;
  for (const a of approvals) {
    if (a.type !== "approval" || a.plan_hash !== planHash) continue;
    if (expiryMs(a) <= now) continue;
    if (!best || expiryMs(a) > expiryMs(best)) best = a;
  }
  return best;
}

/** True when a warrant exists for the plan but every one of them has lapsed —
 *  distinguished from "never approved" so the refusal can say which. */
function hasLapsed(planHash: string, approvals: readonly ApprovalRecord[], now: number): boolean {
  return approvals.some((a) => a.type === "approval" && a.plan_hash === planHash && expiryMs(a) <= now);
}

/** Which gated capabilities this launch reaches for, as bound keys. Empty means the
 *  launch is entirely inside the ungated free set. */
export function gatedCapabilities(facts: LaunchFacts): string[] {
  const needs: string[] = [];
  // Spend: anything but the local free tier.
  if (facts.tier !== undefined && facts.tier !== "free") needs.push("tier");
  else if (facts.executor === "remote") needs.push("tier"); // remote is spend even at free tier
  // Cost proxy. Unresolved counts as gated — see §4.4.
  if (facts.sizeClass === undefined || facts.sizeClass !== "SMALL") needs.push("max_size_class");
  // Device access beyond simulator-only.
  if (facts.device !== undefined && facts.device !== "none") needs.push("device");
  return needs;
}

/** Did a DIFFERENT plan for this same design already hold a live warrant? If so the
 *  refusal is "you recompiled", not "you never approved anything" — a recompile mints a
 *  new plan_hash and correctly invalidates the warrant, but surfacing that as a bare
 *  mid-campaign denial tells the user nothing about what changed or what to do
 *  (spec-20260728 §4.6). Returns false when no plan_compiled rows are supplied. */
function supersededPlan(
  planHash: string,
  approvals: readonly ApprovalRecord[],
  planCompiled: readonly PlanCompiledRecord[],
  now: number,
): boolean {
  // Newest row wins: a plan may be recorded more than once (re-runs of compile).
  const mine = [...planCompiled].filter((r) => r.plan_hash === planHash).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  if (!mine) return false;
  return planCompiled.some(
    (r) => r.design_hash === mine.design_hash && r.plan_hash !== planHash && liveWarrant(r.plan_hash, approvals, now) !== undefined,
  );
}

/** The §5.1 check. */
export function checkWarrant(
  facts: LaunchFacts,
  approvals: readonly ApprovalRecord[],
  now: number,
  /** `plan_compiled` rows, for the SUPERSEDED branch below. Optional so every existing
   *  call site is unchanged; absent simply means the gate cannot tell a recompile from a
   *  never-approved plan and falls back to the generic refusal. */
  planCompiled: readonly PlanCompiledRecord[] = [],
): WarrantCheck {
  const needs = gatedCapabilities(facts);
  if (needs.length === 0) return { ok: true }; // inside the free set — nothing to authorise

  const unresolvedSize = facts.sizeClass === undefined;

  // ── rule 1: no plan_hash → free set only ──
  if (!facts.plan_hash) {
    return {
      ok: false,
      required: needs,
      reason: unresolvedSize
        ? "solve size is unresolved (estimate.ts could not resolve levels), so it is treated as over-threshold and needs an approved plan — declare max_size_class, or make the spec's levels resolvable"
        : `this launch needs an approved plan covering ${needs.join(", ")} — it is outside the ungated free set (local, free tier, SMALL, device none). Set solvespec.plan_hash to an approved plan`,
    };
  }

  // ── rule 2: plan_hash → a live warrant must DECLARE and satisfy each capability ──
  const w = liveWarrant(facts.plan_hash, approvals, now);
  if (!w) {
    return {
      ok: false,
      plan_hash: facts.plan_hash,
      required: needs,
      reason: hasLapsed(facts.plan_hash, approvals, now)
        ? `the warrant for plan ${facts.plan_hash} has expired — re-approve it (needs ${needs.join(", ")})`
        : supersededPlan(facts.plan_hash, approvals, planCompiled, now)
          ? `the plan was recompiled (${facts.plan_hash} supersedes an approved plan for the same design) — re-approve it declaring ${needs.join(", ")}`
          : `no approved warrant for plan ${facts.plan_hash} — approve it declaring ${needs.join(", ")}`,
    };
  }

  const refuse = (reason: string): WarrantRefusal => ({
    ok: false,
    reason,
    required: needs,
    plan_hash: facts.plan_hash,
  });
  const b: WarrantBounds = w.bounds;

  if (needs.includes("tier")) {
    if (b.tier === undefined)
      return refuse(`warrant for ${facts.plan_hash} does not declare tier, which this launch needs — approve it with --tier ${facts.tier ?? "<tier>"}`);
    if (b.tier !== facts.tier)
      return refuse(`tier: launch is "${facts.tier}" but the warrant authorises "${b.tier}"`);
  }

  if (needs.includes("max_size_class")) {
    if (b.max_size_class === undefined)
      return refuse(`warrant for ${facts.plan_hash} does not declare max_size_class, which this launch needs — approve it with --max-size-class ${facts.sizeClass ?? "MEDIUM"}`);
    if (unresolvedSize)
      return refuse(`solve size is unresolved, so it cannot be shown to fit the warrant's max_size_class ${b.max_size_class} — make the spec's levels resolvable`);
    if (SIZE_ORDER[facts.sizeClass!] > SIZE_ORDER[b.max_size_class])
      return refuse(`max_size_class: launch is ${facts.sizeClass} but the warrant authorises up to ${b.max_size_class}`);
  }

  if (needs.includes("device")) {
    if (b.device === undefined)
      return refuse(`warrant for ${facts.plan_hash} does not declare device, which this launch needs — approve it with --device ${facts.device ?? "ro"}`);
    if (DEVICE_ORDER[facts.device!] > DEVICE_ORDER[b.device])
      return refuse(`device: launch needs "${facts.device}" but the warrant authorises "${b.device}"`);
  }

  // max_solves is only checked when declared — it bounds a campaign, and a warrant
  // that omits it simply does not cap the count (unlike the capability bounds above,
  // an absent count is not a capability the launch "reaches for").
  if (b.max_solves !== undefined) {
    const used = facts.solvesSoFar ?? 0;
    if (used >= b.max_solves)
      return refuse(`max_solves: ${used} of ${b.max_solves} already used under plan ${facts.plan_hash} — re-approve to extend`);
  }

  return { ok: true };
}
