// FLEET VERSION SKEW (#1261, Slice 1, AC7): the relay-START gate on client↔host
// version parity. Moved here from #1265 because it is a relay-START concern —
// it protects the host-API-shape assumptions the later slices (#1262 /amicode/*
// proxying, #1264 SSE cursor-resume) build on. A client relay that fronts a
// host speaking a materially different API version would fail DOWNSTREAM with a
// confusing generic timeout; this gate turns that into an ACTIONABLE refusal at
// start, naming both versions and the fix.
//
// The comparison is semver with a selectable TOLERANCE:
//   · "exact"  major.minor.patch must all agree
//   · "minor"  (default) major.minor must agree; the patch may differ
//   · "major"  only the major must agree
// An unparseable version falls back to strict string equality — never a false
// agreement. An unreadable host version (the host down / no version field) is
// NOT a skew refusal: the relay starts and the hub-down posture (AC6) handles
// the unreachable host honestly at request time.

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

export interface RelayVersionGateOptions {
  /** The client's pinned/build version. */
  clientPin: string;
  /** Reads the host version (GET /global/health → version); null = the host
   *  did not report one (down / no field) — NOT a skew, the relay starts. */
  probeHostVersion: () => Promise<string | null>;
  tolerance?: SkewTolerance;
}

export interface RelayVersionGateResult {
  /** Whether the relay may start. */
  start: boolean;
  /** Actionable reason (the refusal message on a skew; a note otherwise). */
  reason: string;
  hostVersion: string | null;
  verdict?: VersionSkewVerdict;
}

/** The relay-start gate: probe the host version, then refuse ONLY on a definite
 *  disagreement beyond tolerance (actionable message). A matching version — or
 *  an unreadable one (host down) — starts; the latter defers to the hub-down
 *  posture, never a false skew refusal. */
export async function relayVersionGate(opts: RelayVersionGateOptions): Promise<RelayVersionGateResult> {
  const hostVersion = await opts.probeHostVersion();
  if (hostVersion === null) {
    return {
      start: true,
      hostVersion: null,
      reason:
        "host version unverified — the host reported none (unreachable / no version field); " +
        "the relay starts and the hub-down posture handles an unreachable host honestly",
    };
  }
  const verdict = versionSkewVerdict(opts.clientPin, hostVersion, opts.tolerance);
  return { start: verdict.agree, reason: verdict.reason, hostVersion, verdict };
}

/** Build a host-version probe from the (late-bound) hub URL + the upstream auth
 *  header: GET `${origin}/global/health` → `version`. Bounded by `timeoutMs`
 *  (default 5s); returns null on no-URL, transport failure, non-200, or a
 *  missing `version` field — every failure is the honest null, never a throw. */
export function hostVersionProbe(
  getUrl: () => string | undefined,
  authHeader: string | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): () => Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async (): Promise<string | null> => {
    const origin = getUrl();
    if (!origin) return null;
    try {
      const res = await fetchImpl(`${origin.replace(/\/+$/, "")}/global/health`, {
        ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" && body.version.trim() !== "" ? body.version : null;
    } catch {
      return null;
    }
  };
}
