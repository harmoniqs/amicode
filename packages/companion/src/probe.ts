// probe.ts — the always-local companion's CLIENT-SIDE hub probe (#1274 AC2,
// ADR 0025 P2). The companion is a `ui`-kind extension: it runs on the CLIENT
// and cannot read the host-side running instance, posture file, or projection.
// So it bundles its OWN probe, which reads only (a) the client-configured hub
// base URL and (b) an injected/global fetch — it dials the URL and reports the
// answer. That independence from host-side state is the point of the split.
//
// The shape mirrors the main extension's probeTransportHealth
// (src/amicode_service/fleet_transport.ts): an HTTP GET to /global/health under
// a client-enforced timeout; a host that ANSWERS (any status, a 5xx included)
// is reachable, no answer (network error / timeout / no URL bound) is not.
// #1275 will bundle the full unified detector ON TOP of this minimal seam.

export interface HubProbeOptions {
  /** The probe's fetch (injectable; default the global fetch). */
  fetch?: typeof fetch;
  /** The liveness endpoint hit on the hub base URL (default /global/health —
   *  the same endpoint the main extension's transport probe uses). */
  healthPath?: string;
  /** The client-enforced probe timeout (ms). Default 1500 (the checkFleet poll's
   *  timeout in the main extension) — the probe always resolves or times out. */
  timeoutMs?: number;
  /** Injectable clock for the latency measurement (prod = Date.now). */
  now?: () => number;
}

/** A CLIENT-SIDE probe result. `reachable` = the host ANSWERED (any HTTP status);
 *  `unreachable` names why (no URL configured, a malformed URL, a network error,
 *  or a client-enforced timeout). */
export type HubProbeResult =
  | { reachable: true; status: number; latencyMs: number }
  | { reachable: false; reason: string };

/** Probe the client-configured hub base URL for liveness — the companion's own,
 *  host-independent sensor. Never throws: every failure is an honest
 *  `{ reachable: false, reason }`. An empty/undefined base URL is the honest
 *  no-hub-configured state and dials NOTHING. */
export async function probeHubHealth(
  baseUrl: string | undefined,
  opts: HubProbeOptions = {},
): Promise<HubProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const healthPath = opts.healthPath ?? "/global/health";
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());

  if (baseUrl === undefined || baseUrl.trim() === "") {
    return { reachable: false, reason: "no-base-url: no hub URL configured on the client" };
  }

  let target: string;
  try {
    target = new URL(healthPath, baseUrl).toString();
  } catch {
    return { reachable: false, reason: `invalid hub base URL: ${baseUrl}` };
  }

  const started = now();
  try {
    const res = await doFetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, status: res.status, latencyMs: now() - started };
  } catch (e) {
    return { reachable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
