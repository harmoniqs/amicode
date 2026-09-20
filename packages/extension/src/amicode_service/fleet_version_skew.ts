// FLEET VERSION SKEW (#1261, Slice 1, AC7): the relay-START gate on client↔host
// version parity. Moved here from #1265 because it is a relay-START concern —
// it protects the host-API-shape assumptions the later slices (#1262 /amicode/*
// proxying, #1264 SSE cursor-resume) build on. A client relay that fronts a
// host speaking a materially different API version would fail DOWNSTREAM with a
// confusing generic timeout; this gate turns that into an ACTIONABLE refusal at
// start, naming both versions and the fix.
//
// The pure verdict (`versionSkewVerdict` + its types) was HOISTED to
// @amicode/schema (amicode#1319) so `amico fleet enroll` (in @amicode/amico-run,
// which cannot import this extension) can reuse the SAME comparison for the
// enroll-time pin check. This module re-exports it unchanged so every existing
// caller/test here is untouched, and keeps the relay-start GATE
// (relayVersionGate/hostVersionProbe) — a fetch-bearing concern that belongs to
// the extension, not the schema contract layer.
//
// The comparison is semver with a selectable TOLERANCE:
//   · "exact"  major.minor.patch must all agree
//   · "minor"  (default) major.minor must agree; the patch may differ
//   · "major"  only the major must agree
// An unparseable version falls back to strict string equality — never a false
// agreement. An unreadable host version (the host down / no version field) is
// NOT a skew refusal: the relay starts and the hub-down posture (AC6) handles
// the unreachable host honestly at request time.

// The pure verdict now lives in @amicode/schema; re-export it here so the relay
// gate below and every existing importer of this module keep their contract.
export { versionSkewVerdict, type SkewTolerance, type VersionSkewVerdict } from "@amicode/schema";
import { versionSkewVerdict } from "@amicode/schema";
import type { SkewTolerance, VersionSkewVerdict } from "@amicode/schema";

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
