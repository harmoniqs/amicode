// deploy_guard.mjs — amicode#992: the deploy pre-flight + the deploy manifest,
// as pure functions so both build_app_bundle.mjs and the vitest suite
// (test/deploy_guard.test.ts) drive the SAME logic. The doctrine: recorded
// main is canonical; anything deploying stale or unrecorded state must fail
// loudly (#992, same class as #964 — recorded state is canonical,
// reference-20260907-021500-agentic-substrate-doctrine).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
// SOURCE OF RECORD for these fixtures is packages/extension/test/
// overlay_known_fixes_964.test.ts — the deploy-side copy below is mirrored
// from it; when the guard's list grows, mirror it here (and the mirrored
// fork branch local/amicode carries the same hunks).
const KNOWN_FIXED_HUNKS = [
  {
    fix: "#929 (59b447e7) — the v2 composer's design placeholder takes the translate callback",
    file: "components/prompt-input-v2.tsx",
    signature: /promptDesignPlaceholder\(\s*mode\(\),\s*placeholder\(\),/,
  },
  {
    fix: "#832 (faac5bdf) — the session-cache diff_version reconciliation shape",
    file: "context/global-sync/session-cache.ts",
    signature: /diff_version: Record<string, number \| undefined>/,
  },
  {
    fix: "#832 (faac5bdf) — the session-cache diff_version guarded delete",
    file: "context/global-sync/session-cache.ts",
    signature: /delete store\.diff_version\[sessionID\]/,
  },
  {
    fix: "#832 (872a5218) — session.exportTrace restored in the non-English app locales",
    file: "i18n/<every locale dict>",
    signature: /"session\.exportTrace"/,
  },
];

const LOCALE_SKIP = new Set(["desktop-native.ts", "parity.test.ts"]);

// overlayAppDir — packages/app-bundle/overlay/packages/app/src (what the
// materialize step folds INTO the built tree, so a missing fix here means a
// missing fix in the dist). Returns regressions as named-remedy strings.
export function checkKnownFixes(overlayAppDir) {
  const regressed = [];
  for (const kf of KNOWN_FIXED_HUNKS) {
    if (kf.file === "i18n/<every locale dict>") {
      const locales = readdirSync(join(overlayAppDir, "i18n")).filter(
        (f) => f.endsWith(".ts") && !LOCALE_SKIP.has(f),
      );
      if (locales.length === 0) {
        regressed.push(
          `KNOWN-FIX UNCHECKABLE in i18n/: no locale dicts found under ${overlayAppDir}/i18n — ` +
            `the overlay tree is not a materializable app source. REMEDY: pass the real overlay root ` +
            `(packages/app-bundle/overlay/packages/app/src). See harmoniqs/amicode#964.`,
        );
        continue;
      }
      for (const f of locales) {
        const source = readFileSync(join(overlayAppDir, "i18n", f), "utf8");
        if (!kf.signature.test(source))
          regressed.push(knownFixRefusal(`i18n/${f}`, kf.fix));
      }
      continue;
    }
    const source = readFileSync(join(overlayAppDir, kf.file), "utf8");
    if (!kf.signature.test(source)) regressed.push(knownFixRefusal(kf.file, kf.fix));
  }
  return regressed;
}

function knownFixRefusal(path, fix) {
  return (
    `REFUSED: KNOWN-FIX MISSING in ${path}: ${fix}. A build from this tree would serve the dist WITHOUT a ` +
    `recorded fix (the #964 class). REMEDY: restore the fix in the overlay ` +
    `(packages/app-bundle/overlay/packages/app/src — the guard test ` +
    `packages/extension/test/overlay_known_fixes_964.test.ts is the source of record for the hunk list; ` +
    `the fork branch local/amicode carries the same hunks so the next sync brings the fix, not the regression), ` +
    `land it via PR, then redeploy. See harmoniqs/amicode#964 and #992.`
  );
}

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
