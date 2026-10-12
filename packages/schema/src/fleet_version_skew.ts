// FLEET VERSION SKEW — the pure client↔host version-parity verdict.
//
// HOISTED to @amicode/schema (amicode#1319) from its original home
// (packages/extension/src/amicode_service/fleet_version_skew.ts, #1261) so the
// two cross-package consumers share ONE definition:
//   · the extension's relay-START gate (relayVersionGate/hostVersionProbe stay
//     in the extension and re-export this pure core), and
//   · `amico fleet enroll` in @amicode/amico-run — which cannot import the
//     extension — for the enroll-time PIN CHECK: a join token whose pin_version
//     disagrees with a host-version probe is rejected BEFORE any file is written
//     (#1319 AC4). Reusing the ONE pure verdict is why it lives here.
//
// The comparison is semver with a selectable TOLERANCE:
//   · "exact"  major.minor.patch must all agree
//   · "minor"  (default) major.minor must agree; the patch may differ
//   · "major"  only the major must agree
// An unparseable version falls back to strict string equality — never a false
// agreement.

/** The selectable skew tolerance. */
export type SkewTolerance = "exact" | "minor" | "major";

export interface VersionSkewVerdict {
  agree: boolean;
  clientPin: string;
  hostVersion: string;
  tolerance: SkewTolerance;
  /** Actionable on disagreement (names both versions + the fix); a short
   *  agreement note otherwise. Never a bare timeout. */
  reason: string;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a semver-ish string: a leading `v` is tolerated, a pre-release/build
 *  suffix (`-rc.1`, `+meta`) is ignored, and only major.minor.patch are read.
 *  Returns null when the core triple is not three integers. */
function parseSemver(raw: string): Semver | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const core = cleaned.split(/[-+]/, 1)[0];
  const parts = core.split(".");
  if (parts.length < 2) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2] ?? 0 };
}

/** The pure verdict: do the client pin and host version agree WITHIN the
 *  tolerance? Default tolerance is `minor` (major.minor must agree). */
export function versionSkewVerdict(
  clientPin: string,
  hostVersion: string,
  tolerance: SkewTolerance = "minor",
): VersionSkewVerdict {
  const base = { clientPin, hostVersion, tolerance };
  const c = parseSemver(clientPin);
  const h = parseSemver(hostVersion);
  // Unparseable on either side → strict string equality, never a false agree.
  if (c === null || h === null) {
    const agree = clientPin.trim() === hostVersion.trim();
    return {
      ...base,
      agree,
      reason: agree
        ? `versions match exactly (${clientPin})`
        : `client pinned ${clientPin} but the host reports ${hostVersion}, and neither is parseable semver — ` +
          `align the two exactly (upgrade the client or the host) so the relay can trust the host API shape`,
    };
  }
  const agree =
    tolerance === "exact"
      ? c.major === h.major && c.minor === h.minor && c.patch === h.patch
      : tolerance === "minor"
        ? c.major === h.major && c.minor === h.minor
        : c.major === h.major;
  if (agree) {
    return {
      ...base,
      agree: true,
      reason: `versions agree within the ${tolerance} tolerance (client ${clientPin}, host ${hostVersion})`,
    };
  }
  const level = c.major !== h.major ? "major" : c.minor !== h.minor ? "minor" : "patch";
  return {
    ...base,
    agree: false,
    reason:
      `client pinned ${clientPin} but the host is ${hostVersion} — they disagree at the ${level} version ` +
      `(tolerance: ${tolerance}); upgrade the client or the host so their ${tolerance === "major" ? "major" : tolerance === "exact" ? "full" : "major.minor"} versions match`,
  };
}
