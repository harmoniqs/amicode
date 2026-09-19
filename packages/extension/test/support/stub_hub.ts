// stub_hub — the #792 relay stub-hub harness, extracted so the #1260 transport
// provider-conformance tests REUSE the same host contract the relay test
// introduced (Testing Decisions: "reuse the stub-hub harness the #792 relay test
// introduces rather than a new fixture") rather than inventing a competing one.
//
// The contract mirrors `startStubHost` in fleet_client_relay.test.ts and the beta
// smoke's FixtureHub: a loopback (127.0.0.1) opencode-shaped server that answers
// `/global/health` with `{healthy, version}` and `/session` with the seeded list,
// and 401s anything but the hub mint (so a 200 proves credential translation).
import * as http from "node:http";
import { AddressInfo } from "node:net";

export interface StubHub {
  url: string;
  requests: string[];
  authSeen: string[];
  stop(): Promise<void>;
}

export interface StubHubOptions {
  /** Sessions returned from GET /session (default: two). */
  sessions?: unknown[];
  /** The version reported by GET /global/health (default v1.18.29). */
  version?: string;
  /** When set, every request 401s unless it carries exactly this
   *  Authorization header (the hub mint). Omit → auth is not enforced. */
  requireAuth?: string;
}

const DEFAULT_SESSIONS = [
  { id: "ses-host-1", title: "host one", time: { created: 3000, updated: 9000 } },
  { id: "ses-host-2", title: "host two", time: { created: 4000, updated: 9500 } },
];

/** Start a loopback stub hub. Resolves once listening on an ephemeral port. */
export function startStubHub(opts: StubHubOptions = {}): Promise<StubHub> {
  const sessions = opts.sessions ?? DEFAULT_SESSIONS;
  const version = opts.version ?? "v1.18.29";
  const requests: string[] = [];
  const authSeen: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    authSeen.push(req.headers.authorization ?? "");
    if (opts.requireAuth !== undefined && req.headers.authorization !== opts.requireAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        authSeen,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
