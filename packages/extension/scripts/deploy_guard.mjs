// deploy_guard.mjs — amicode#992: the deploy pre-flight + the deploy manifest,
// as pure functions so both build_app_bundle.mjs and the vitest suite
// (test/deploy_guard.test.ts) drive the SAME logic. The doctrine: recorded
// main is canonical; anything deploying stale or unrecorded state must fail
// loudly (#992, same class as #964 — recorded state is canonical,
// reference-20260907-021500-agentic-substrate-doctrine).
import { checkKnownFixes } from "../../app-bundle/scripts/known_fixes.mjs";

// The #964 known-fixes check now lives in ONE shared module
// (packages/app-bundle/scripts/known_fixes.mjs) so the deploy guard and the
// fork→overlay sync cannot drift. Re-exported here for the deploy caller
// (build_app_bundle.mjs) and its test. See #842.
export { checkKnownFixes };

// ── Pre-flight evaluation (pure) ────────────────────────────────────────────
// Inputs are gathered by the caller (git, fs); the decision lives here so the
// tests can drive every branch without shelling out.
//
//   headSha        — the local HEAD's full sha
//   originMainSha  — origin/main's full sha (after a fetch)
//   relation       — "at" | "BEHIND" | "DIVERGED" (caller computes via
//                    `git merge-base --is-ancestor`; headRelation below)
//   dirtyEntries   — `git status --porcelain` lines ([] when clean)
//   overrideReason — $AMICODE_DEPLOY_OVERRIDE (undefined when unset)
//
// Returns { ok: true, overrideReason: string|null, recorded: string[] } on
// proceed, or { ok: false, reasons: string[] } with one NAMED reason + remedy
// per failure. An override MUST carry a non-empty reason: an empty or missing
// reason with the flag set refuses (no silent overrides) — and a VALID
// override waives the stale/dirty refusal (an honest hotfix) but is RECORDED
// in the returned decision so the manifest stamps it. The #964 known-fixes
// refusal is NEVER overridable — a tree missing a recorded fix does not build
// a deploy, hotfix or not.
export function evaluatePreflight({ headSha, originMainSha, relation, dirtyEntries, overrideReason }) {
  const reasons = [];
  const hasOverrideFlag = overrideReason !== undefined;
  const validOverride = hasOverrideFlag && String(overrideReason).trim() !== "";

  if (!validOverride && headSha !== originMainSha) {
    const rel = relation && relation !== "at" ? relation : "≠";
    reasons.push(
      `REFUSED: HEAD ${headSha.slice(0, 12)} is ${rel} origin/main (${originMainSha.slice(0, 12)}) — ` +
        `a deploy from a non-recorded-main tree can serve unrecorded state over a recorded fix (the 2026-09-10 deploy race, #992). ` +
        `REMEDY: pull/rebase onto origin/main and land any local work via a PR, then redeploy ` +
        `(or set AMICODE_DEPLOY_OVERRIDE=<reason> to proceed with the hotfix recorded).`,
    );
  }
  if (!validOverride && dirtyEntries.length > 0) {
    reasons.push(
      `REFUSED: the working tree is dirty (${dirtyEntries.length} entr${dirtyEntries.length === 1 ? "y" : "ies"}: ` +
        `${dirtyEntries.slice(0, 5).map((e) => e.trim()).join("; ")}${dirtyEntries.length > 5 ? "; …" : ""}) — ` +
        `a dirty tree's build output does not trace to any recorded commit. ` +
        `REMEDY: commit via a PR, or stash before deploying ` +
        `(or set AMICODE_DEPLOY_OVERRIDE=<reason> to proceed with the hotfix recorded).`,
    );
  }
  if (hasOverrideFlag && !validOverride) {
    reasons.push(
      `REFUSED: AMICODE_DEPLOY_OVERRIDE is set but its reason is empty — overrides without a stated reason ` +
        `are silent hotfixes, and silent hotfixes are exactly what #992 exists to prevent. ` +
        `REMEDY: set AMICODE_DEPLOY_OVERRIDE to a non-empty reason (it will be recorded in deploy.json).`,
    );
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const reason = validOverride ? String(overrideReason).trim() : null;
  const recorded = [];
  if (validOverride) {
    if (headSha !== originMainSha)
      recorded.push(
        `OVERRIDE (stale tree: HEAD ${headSha.slice(0, 12)} ${relation ?? "≠"} origin/main): ${reason}`,
      );
    if (dirtyEntries.length > 0)
      recorded.push(`OVERRIDE (dirty tree: ${dirtyEntries.length} entries): ${reason}`);
    recorded.push(
      `OVERRIDE RECORDED: AMICODE_DEPLOY_OVERRIDE="${reason}" — stamped into dist-app/deploy.json`,
    );
  }
  return { ok: true, overrideReason: reason, recorded };
}

// A thin helper the script uses after `git merge-base --is-ancestor` probes —
// pure: it just picks the relation label.
//   headIsAncestor    — merge-base --is-ancestor HEAD origin/main
//   originIsAncestor  — merge-base --is-ancestor origin/main HEAD
export function headRelation(headSha, originMainSha, headIsAncestor, originIsAncestor) {
  if (headSha === originMainSha) return "at";
  if (headIsAncestor) return "BEHIND";
  if (originIsAncestor) return "AHEAD of";
  return "DIVERGED from";
}

// ── The known-fixes check (#964's hunks, checked at deploy time) ────────────
// Implemented in packages/app-bundle/scripts/known_fixes.mjs (the shared module
// the fork→overlay sync also consumes) and re-exported at the top of this file.
// SOURCE OF RECORD for the fixture list: packages/extension/test/
// overlay_known_fixes_964.test.ts; the deploy guard's test cross-checks the
// shared list against it so the two cannot drift.

// ── The deploy manifest (#992 slice 2) ──────────────────────────────────────
// Pure builder: the script supplies observed values; the shape is contract.
export function buildDeployManifest({ commit, branch, dirty, overrideReason, builtAt, deployedBy }) {
  return {
    commit, // full sha of the tree the dist was built from
    branch,
    dirty, // whether the tree had uncommitted changes at build time
    override_reason: overrideReason ?? null,
    built_at: builtAt, // ISO timestamp
    deployed_by: deployedBy, // user@host
  };
}
