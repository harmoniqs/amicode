// FLEET WRITES (amicissimo#392 — the local-shell data plane, Slice B, D3+D5):
// the write-failure contract. The hub is the store of record for FLEET
// sessions; every fleet write resolves to ONE of the enumerated outcomes —
//
//   delivered   a 2xx was SEEN (the hub's own answer passes through verbatim)
//   failed      an error was SEEN (surfaced, named; the compose input is
//               echoed back — never silently eaten)
//   ambiguous   in flight at disconnect (no response seen) — surfaced as
//               ambiguous, NEVER eaten: it triggers a bounded idempotent
//               retry carrying the SAME client-generated request identity
//               (the hub dedupes on it where the contract carries such a
//               field — a vNext additive candidate — and where it does not,
//               the client resolves the ambiguity by re-fetching the
//               affected thread, which this module performs and attaches as
//               evidence)
//
// A failed hub write names the LOCAL STORE'S ROLE explicitly: a fleet
// session is never shadowed into the local store (D3) — the role is
// recorded on the outcome either way, so "what landed where" is never
// ambiguous.
//
// D5's revocation handoff rides the failed outcome: a 401 from the hub is
// the mid-flight entitlement lapse — the affected session transitions to
// read-only-with-pointer (an honest eviction notice + the Go-Standalone
// handoff); content already hub-resident is re-accessible on re-entitlement.
//
// D6's client-enforced timeout bounds every attempt: the client always
// resolves or times out — this path feeds the posture detector with the
// outcomes it observes, it never awaits a wedged tunnel.
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import type { DataPlaneOutcome } from "./fleet_posture";
import { HubCredentialRead, hubUpstreamAuthHeader } from "./hub_credential";

/** The named max body cap for the write pipeline (mirrors the service's
 *  readBody cap). */
const MAX_BODY_BYTES = 1024 * 1024;
/** The refetch-evidence body cap attached to an ambiguous outcome. */
const MAX_REFETCH_BODY = 65536;

/** The local store's role on a fleet-session write outcome — recorded
 *  explicitly so "what landed where" is never ambiguous (D3). */
export const LOCAL_STORE_ROLE_FLEET_SESSION =
  "unwritten — fleet sessions are never shadowed into the local store; the hub is the store of record (D3)";

export const REVOCATION_NOTICE =
  "entitlement revoked mid-flight — this session is now read-only with a pointer; " +
  "content already hub-resident is re-accessible on re-entitlement; " +
  "use Go-Standalone to continue locally";

export interface FleetWriteRevocation {
  handoff: "read-only-with-pointer";
  notice: string;
  go_standalone: boolean;
}

export type FleetWriteResult =
  | {
      status: "delivered";
      httpStatus: number;
      body: string;
      contentType: string | null;
      requestId: string;
      attempts: number;
    }
  | {
      status: "failed";
      /** The status to SEND the client: the hub's own status when one was
       *  seen; the named 503s for the transport-level failures. */
      httpStatus: number;
      error: string;
      /** The hub's own status, when one was seen. */
      hubStatus: number | null;
      detail?: string;
      payload: string;
      payloadTruncated?: boolean;
      requestId: string;
      attempts: number;
      localStoreRole: string;
      revocation?: FleetWriteRevocation;
    }
  | {
      status: "ambiguous";
      error: "fleet-write-ambiguous";
      detail?: string;
      payload: string;
      payloadTruncated?: boolean;
      requestId: string;
      attempts: number;
      localStoreRole: string;
      /** The re-fetch of the affected thread — the ambiguity resolution
       *  evidence (D3: where the contract carries no dedupe field, the
       *  client resolves by re-fetching). */
      refetch: { path: string; ok: boolean; httpStatus: number | null; body: string | null } | null;
    };

export interface FleetWriteRequest {
  method: string;
  /** Path + query as received. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FleetWriteDeps {
  getUrl(): string | undefined;
  /** The hub mint's NAMED read — per write, so a mid-session credential
   *  change is honored. */
  credential(): HubCredentialRead;
  fetchImpl?: typeof fetch;
  /** D6: the client-enforced write timeout (every attempt is bounded by
   *  it — the detector observes outcomes, it does not await a wedged
   *  tunnel). Default 10s. */
  timeoutMs?: number;
  /** D3: the bounded idempotent retry budget (attempts = 1 + maxRetries).
   *  Default 2. */
  maxRetries?: number;
  /** The posture detector's diet: every attempt's outcome feeds it. */
  onOutcome?: (o: DataPlaneOutcome) => void;
  /** The tunnel generation stamp (D7) merged into our envelopes. */
  responseStamp?: () => Record<string, string> | undefined;
}

/** Hop-by-hop headers a proxy must not forward (RFC 7230 §6.1) — plus the
 *  two this pipeline OWNS: `authorization` (the hub mint translation) and
 *  `x-amicode-request-id` (the client-generated request identity). */
const DROPPED_HEADERS = new Set(["host", "connection", "authorization", "x-amicode-request-id", "content-length"]);

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (v === undefined) continue;
    return Array.isArray(v) ? v.join(", ") : v;
  }
  return undefined;
}

/** D3's refetch derivation: a write to a thread refetches that thread; a
 *  session create refetches the list. Documented heuristic — the refetch is
 *  evidence for the caller's reconciliation, never a silent re-write. */
export function deriveRefetchPath(writePath: string): string {
  const segs = writePath.split("?")[0].split("/").filter((s) => s !== "");
  if (segs.length === 0) return "/session";
  if (segs[0] === "session") {
    if (segs.length >= 2) return `/session/${segs[1]}`;
    return "/session";
  }
  return `/${segs[0]}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncateBody(body: string): { payload: string; payloadTruncated?: boolean } {
  if (body.length <= MAX_REFETCH_BODY) return { payload: body };
  return { payload: body.slice(0, MAX_REFETCH_BODY), payloadTruncated: true };
}

export async function executeFleetWrite(deps: FleetWriteDeps, write: FleetWriteRequest): Promise<FleetWriteResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxRetries = deps.maxRetries ?? 2;
  const localStoreRole = LOCAL_STORE_ROLE_FLEET_SESSION;
  const { payload, payloadTruncated } = truncateBody(write.body);
  const requestId = headerValue(write.headers, "x-amicode-request-id") ?? randomUUID();

  const base = deps.getUrl();
  if (!base) {
    return {
      status: "failed",
      httpStatus: 503,
      error: "hub upstream not available",
      hubStatus: null,
      payload,
      ...(payloadTruncated ? { payloadTruncated } : {}),
      requestId,
      attempts: 0,
      localStoreRole,
    };
  }
  const cred = deps.credential();
  if (!cred.ok) {
    return {
      status: "failed",
      httpStatus: 503,
      error: "hub-credential-missing",
      hubStatus: null,
      detail: cred.reason,
      payload,
      ...(payloadTruncated ? { payloadTruncated } : {}),
      requestId,
      attempts: 0,
      localStoreRole,
    };
  }

  // The same translation the streaming proxy applies: strip the inbound
  // credential and the ?auth_token carrier (garbage to the hub), attach the
  // hub mint, and carry the request identity on every attempt (D3's
  // idempotent retry — the hub dedupes on it where the contract has it).
  const incoming = new URL(write.url, base);
  incoming.searchParams.delete("auth_token");
  const target = new URL(incoming.toString());
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(write.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (DROPPED_HEADERS.has(lk)) continue;
    headers[lk] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["authorization"] = hubUpstreamAuthHeader(cred.credential.token);
  headers["x-amicode-request-id"] = requestId;

  let attempts = 0;
  let lastDetail: string | undefined;
  while (attempts <= maxRetries) {
    attempts++;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(target, {
        method: write.method,
        headers,
        body: write.body.length > 0 ? write.body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      deps.onOutcome?.({ kind: "no-response", detail: lastDetail });
      continue; // ambiguous in flight → the bounded idempotent retry
    }
    deps.onOutcome?.({ kind: "responded", latencyMs: Date.now() - started });
    const text = await safeText(res);
    if (res.status >= 200 && res.status < 300) {
      return { status: "delivered", httpStatus: res.status, body: text, contentType: res.headers.get("content-type"), requestId, attempts };
    }
    if (res.status === 401) {
      // D5: the mid-flight entitlement lapse — read-only-with-pointer.
      return {
        status: "failed",
        httpStatus: 401,
        error: "fleet-write-failed",
        hubStatus: 401,
        payload,
        ...(payloadTruncated ? { payloadTruncated } : {}),
        requestId,
        attempts,
        localStoreRole,
        revocation: { handoff: "read-only-with-pointer", notice: REVOCATION_NOTICE, go_standalone: true },
      };
    }
    return {
      status: "failed",
      httpStatus: res.status,
      error: "fleet-write-failed",
      hubStatus: res.status,
      detail: `hub answered HTTP ${res.status}`,
      payload,
      ...(payloadTruncated ? { payloadTruncated } : {}),
      requestId,
      attempts,
      localStoreRole,
    };
  }

  // Retries exhausted with no response seen: resolve the ambiguity by
  // re-fetching the affected thread (D3) and surface it — never eaten.
  const refetchPath = deriveRefetchPath(incoming.pathname);
  let refetch: { path: string; ok: boolean; httpStatus: number | null; body: string | null };
  try {
    const r = await fetchImpl(new URL(refetchPath, base), {
      headers: { authorization: headers["authorization"] },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await safeText(r);
    refetch = { path: refetchPath, ok: r.ok, httpStatus: r.status, body: body.length > MAX_REFETCH_BODY ? body.slice(0, MAX_REFETCH_BODY) : body };
  } catch {
    refetch = { path: refetchPath, ok: false, httpStatus: null, body: null };
  }
  return {
    status: "ambiguous",
    error: "fleet-write-ambiguous",
    ...(lastDetail !== undefined ? { detail: lastDetail } : {}),
    payload,
    ...(payloadTruncated ? { payloadTruncated } : {}),
    requestId,
    attempts,
    localStoreRole,
    refetch,
  };
}

/** The HTTP face of the write contract: buffer the (small, JSON) request
 *  body, execute the contract, send the enumerated outcome. Returns true
 *  once the response is owned (always, unless it throws — and it never
 *  throws into the server). */
export async function handleFleetWrite(
  deps: FleetWriteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  try {
    const body = await readRequestBody(req);
    const result = await executeFleetWrite(deps, {
      method: req.method ?? "POST",
      url: req.url ?? "/",
      headers: { ...req.headers },
      body,
    });
    const stamp = deps.responseStamp?.() ?? {};
    if (result.status === "delivered") {
      res.writeHead(result.httpStatus, { "content-type": result.contentType ?? "application/json", ...stamp });
      res.end(result.body);
      return true;
    }
    if (result.status === "failed") {
      res.writeHead(result.httpStatus, { "content-type": "application/json", ...stamp });
      res.end(
        JSON.stringify({
          ok: false,
          error: result.error,
          hub_status: result.hubStatus,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
          payload: result.payload,
          ...(result.payloadTruncated ? { payload_truncated: true } : {}),
          request_id: result.requestId,
          attempts: result.attempts,
          local_store_role: result.localStoreRole,
          ...(result.revocation ? { revocation: result.revocation } : {}),
        }),
      );
      return true;
    }
    res.writeHead(504, { "content-type": "application/json", ...stamp });
    res.end(
      JSON.stringify({
        ok: false,
        error: result.error,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        payload: result.payload,
        ...(result.payloadTruncated ? { payload_truncated: true } : {}),
        request_id: result.requestId,
        attempts: result.attempts,
        local_store_role: result.localStoreRole,
        refetch: result.refetch
          ? { path: result.refetch.path, ok: result.refetch.ok, http_status: result.refetch.httpStatus, body: result.refetch.body }
          : null,
      }),
    );
    return true;
  } catch (e) {
    try {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `fleet write pipeline failed: ${e}` }));
      } else {
        res.end();
      }
    } catch {
      /* never throw into the server */
    }
    return true;
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
