// LOCAL SESSION PROBE (#1774): "does the LOCAL engine hold this session?" — the
// local-first half of the unknown-owner outcome. A session-scoped request whose
// id has NO known owner (the owner map has not caught up — a just-created local
// session, or a peer whose entries expired) is tried on the local engine first;
// only the engine's own 404 for the session detail read means "not here", and
// the caller then answers a retryable owner-unknown 503 instead of letting the
// request become a 404 or an empty result.
//
// The probe is the engine's own session detail read (`GET /session/{id}` → 404
// on a storage miss), sent with the request's OWN credential and directory scope
// (the same Authorization the engine proxy would forward), never a body. Any
// other answer — 2xx, an auth refusal, a 5xx, a transport error, a timeout — is
// not a verdict: the request falls through to the local engine, which answers
// for itself exactly as before.
import type * as http from "node:http";

/** present → the local engine holds it; absent → its own 404; unknown → no verdict. */
export type LocalSessionPresence = "present" | "absent" | "unknown";

/** The probe's bound when the caller sets none — short: it sits in front of a request. */
export const LOCAL_SESSION_PROBE_TIMEOUT_MS = 3_000;

/** The directory/workspace scope carriers a request may hold (header or query). */
const SCOPE_HEADERS = ["x-opencode-directory", "x-opencode-workspace"] as const;
const SCOPE_PARAMS = ["directory", "workspace", "auth_token"] as const;

export async function probeLocalSession(opts: {
  /** The local engine origin, read per request; undefined → no verdict. */
  localUrl: string | undefined;
  sessionId: string;
  /** The incoming request: its credential and scope ride on the probe. */
  req: Pick<http.IncomingMessage, "url" | "headers">;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LocalSessionPresence> {
  if (!opts.localUrl) return "unknown";
  try {
    const target = new URL(`/session/${encodeURIComponent(opts.sessionId)}`, opts.localUrl);
    const incoming = new URL(opts.req.url ?? "/", "http://origin");
    for (const p of SCOPE_PARAMS) {
      const v = incoming.searchParams.get(p);
      if (v !== null) target.searchParams.set(p, v);
    }
    const headers: Record<string, string> = {};
    const auth = opts.req.headers.authorization;
    if (typeof auth === "string") headers.authorization = auth;
    for (const h of SCOPE_HEADERS) {
      const v = opts.req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const res = await (opts.fetchImpl ?? fetch)(target.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? LOCAL_SESSION_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return "absent";
    return res.ok ? "present" : "unknown";
  } catch {
    return "unknown";
  }
}
