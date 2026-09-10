// known_fixes.mjs — the amicode-fixes-are-canonical rule, as one shared module.
//
// amicode#964: the fork→overlay sync treats the fork as authoritative for every
// file it copies — including files where amicode fixed what the fork never had.
// ff7b69c8 regressed #929's 3-arg translate callback that way. The invariant
// this module encodes: a file whose overlay copy carries a recorded amicode-side
// fix is NOT downstream of the fork; a sync (or a deploy) that would revert one
// must fail loudly, naming the fix.
//
// SOURCE OF RECORD for the fixture list is
// packages/extension/test/overlay_known_fixes_964.test.ts (the human-facing
// assertion over the overlay). This module is the machine-usable copy the sync
// and deploy guards share, and the deploy guard's cross-check test keeps the two
// in lock-step. Imports come from here so there is never a third forked copy:
// packages/app-bundle/scripts/overlay-sync.mjs and packages/extension/scripts/
// deploy_guard.mjs both consume it.
//
// Extensible as fixes accumulate: add a fixture (file, hunk signature, fix
// reference) here AND to the #964 test. The mirrored fork branch
// (harmoniqs/opencode local/amicode) carries the same hunks so the next sync
// brings the FIX, not the regression.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const LOCALE_SKIP = new Set(["desktop-native.ts", "parity.test.ts"]);

export const KNOWN_FIXED_HUNKS = [
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

// localeDicts — the non-English dicts under an app-src dir, sorted. Empty means
// the tree is not a materializable app source (the caller refuses, uncheckable).
export function localeDicts(appSrcDir) {
  return readdirSync(join(appSrcDir, "i18n"))
    .filter((f) => f.endsWith(".ts") && !LOCALE_SKIP.has(f))
    .sort();
}

function knownFixRefusal(path, fix) {
  return (
    `REFUSED: KNOWN-FIX MISSING in ${path}: ${fix}. A sync/build from this state would carry the tree ` +
    `WITHOUT a recorded amicode-side fix (the #964 class). REMEDY: restore the fix in the overlay ` +
    `(packages/app-bundle/overlay/packages/app/src) and make sure the fork branch local/amicode carries ` +
    `the same hunk so the next sync brings the fix, not the regression. The source of record for the hunk ` +
    `list is packages/extension/test/overlay_known_fixes_964.test.ts. See harmoniqs/amicode#964 and #842.`
  );
}

function uncheckableRefusal(appSrcDir) {
  return (
    `REFUSED: KNOWN-FIX UNCHECKABLE in i18n/: no locale dicts found under ${appSrcDir}/i18n — ` +
    `the tree is not a materializable app source. REMEDY: pass the real overlay root ` +
    `(packages/app-bundle/overlay/packages/app/src). See harmoniqs/amicode#964.`
  );
}

// evaluateKnownFixes — the pure core. `readSource(rel)` returns the text of a
// file relative to app-src (or null when absent); `listLocales()` returns the
// locale filenames. Returns named-remedy refusal strings ([] === all present).
// Content-injectable so the sync can check the POST-APPLY tree before writing.
export function evaluateKnownFixes(readSource, listLocales, appSrcDir = "<injected>") {
  const regressed = [];
  for (const kf of KNOWN_FIXED_HUNKS) {
    if (kf.file === "i18n/<every locale dict>") {
      const locales = listLocales();
      if (locales.length === 0) {
        regressed.push(uncheckableRefusal(appSrcDir));
        continue;
      }
      for (const f of locales) {
        const source = readSource(`i18n/${f}`);
        if (source == null || !kf.signature.test(source)) regressed.push(knownFixRefusal(`i18n/${f}`, kf.fix));
      }
      continue;
    }
    const source = readSource(kf.file);
    if (source == null || !kf.signature.test(source)) regressed.push(knownFixRefusal(kf.file, kf.fix));
  }
  return regressed;
}

// checkKnownFixes — the disk-backed convenience the deploy guard uses. Reads an
// app-src dir (packages/app-bundle/overlay/packages/app/src).
export function checkKnownFixes(appSrcDir) {
  return evaluateKnownFixes(
    (rel) => {
      try {
        return readFileSync(join(appSrcDir, rel), "utf8");
      } catch {
        return null;
      }
    },
    () => {
      try {
        return localeDicts(appSrcDir);
      } catch {
        return [];
      }
    },
    appSrcDir,
  );
}
