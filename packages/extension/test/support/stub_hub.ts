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
  /** #1267: the host file MUTATIONS the stub received (write/rename/delete/mkdir)
   *  — the "the mutation landed on the host" evidence, mirroring the relay
   *  test's amicodePosts. Each carries the op verb and the parsed body. */
  hostOps: { op: string; body: Record<string, unknown> }[];
  stop(): Promise<void>;
}

/** #1267: a seeded in-memory host filesystem, keyed mount → relpath → utf8
 *  content. The stub serves the REAL vault-browser read contract over it
 *  (GET /amicode/vaults + /amicode/vault-files + /amicode/vault-file) and, when
 *  writable, the INTENDED host mutation routes the provider consumes (which the
 *  real engine does NOT yet serve — the documented #1267 host-side gap). */
export interface HostFsSeed {
  [mount: string]: { kind?: string; writable?: boolean; files: Record<string, string> };
}

export interface StubHubOptions {
  /** Sessions returned from GET /session (default: two). */
  sessions?: unknown[];
  /** The version reported by GET /global/health (default v1.18.29). */
  version?: string;
  /** When set, every request 401s unless it carries exactly this
   *  Authorization header (the hub mint). Omit → auth is not enforced. */
  requireAuth?: string;
  /** #1267: seed the host file plane. Omit → the vault read routes report an
   *  empty/absent filesystem (the routes still answer, honestly). */
  hostFiles?: HostFsSeed;
  /** #1267: when true, the host mutation routes (write/rename/delete/mkdir) are
   *  NOT served → they 404, exactly as the current real engine does (it has no
   *  generic host write route). Lets a test pin the provider's honest
   *  RouteAbsent path against a read-only host. Default false (mutations served). */
  hostReadOnly?: boolean;
}

const DEFAULT_SESSIONS = [
  { id: "ses-host-1", title: "host one", time: { created: 3000, updated: 9000 } },
  { id: "ses-host-2", title: "host two", time: { created: 4000, updated: 9500 } },
];

const errBody = (code: string, detail: string) => JSON.stringify({ ok: false, error: `${code}: ${detail}` });

/** The in-memory host FS backing the vault routes: mount → (relpath → content).
 *  Directories are implicit from file paths (the real vault-browser returns a
 *  FLAT recursive file list — the provider synthesizes the tree), plus any
 *  explicitly created empty dirs. */
class StubHostFs {
  private readonly mounts = new Map<string, { kind: string; writable: boolean; files: Map<string, string>; dirs: Set<string> }>();
  constructor(seed: HostFsSeed = {}) {
    for (const [mount, spec] of Object.entries(seed)) {
      const files = new Map<string, string>(Object.entries(spec.files));
      this.mounts.set(mount, { kind: spec.kind ?? "personal", writable: spec.writable ?? true, files, dirs: new Set() });
    }
  }
  listMounts() {
    return [...this.mounts.entries()].map(([id, m]) => ({ id, kind: m.kind, writable: m.writable, last_sync: "unknown" }));
  }
  vaultFilesBody(mount: string | undefined): string {
    if (!mount) return errBody("bad_request", "mount is required");
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    const files = [...m.files.entries()].map(([rel, content]) => ({
      path: rel,
      name: rel.split("/").pop()!,
      size: Buffer.byteLength(content, "utf8"),
      readable: true,
    }));
    return JSON.stringify({ ok: true, mount, count: files.length, truncated: false, files });
  }
  vaultFileBody(mount: string | undefined, rel: string | undefined): string {
    if (!mount) return errBody("bad_request", "mount is required");
    if (!rel) return errBody("bad_request", "path is required");
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    const content = m.files.get(rel);
    if (content === undefined) return errBody("not_found", `no such file in "${mount}": ${rel}`);
    return JSON.stringify({ ok: true, mount, path: rel, size: Buffer.byteLength(content, "utf8"), content });
  }
  write(mount: string, rel: string, content: string): string {
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    if (!m.writable) return errBody("forbidden", `vault "${mount}" is read-only`);
    m.files.set(rel, content);
    return JSON.stringify({ ok: true, mount, path: rel });
  }
  rename(mount: string, from: string, to: string): string {
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    // rename a file, or a directory prefix (every file under from/ moves to to/).
    if (m.files.has(from)) {
      const content = m.files.get(from)!;
      m.files.delete(from);
      m.files.set(to, content);
      return JSON.stringify({ ok: true, mount, from, to });
    }
    const prefix = from + "/";
    const moved = [...m.files.keys()].filter((k) => k.startsWith(prefix));
    if (moved.length === 0) return errBody("not_found", `no such path in "${mount}": ${from}`);
    for (const k of moved) {
      const content = m.files.get(k)!;
      m.files.delete(k);
      m.files.set(to + "/" + k.slice(prefix.length), content);
    }
    return JSON.stringify({ ok: true, mount, from, to });
  }
  del(mount: string, rel: string): string {
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    if (m.files.delete(rel)) return JSON.stringify({ ok: true, mount, path: rel });
    const prefix = rel + "/";
    const under = [...m.files.keys()].filter((k) => k.startsWith(prefix));
    if (under.length > 0) {
      for (const k of under) m.files.delete(k);
      return JSON.stringify({ ok: true, mount, path: rel });
    }
    m.dirs.delete(rel);
    return JSON.stringify({ ok: true, mount, path: rel });
  }
  mkdir(mount: string, rel: string): string {
    const m = this.mounts.get(mount);
    if (!m) return errBody("not_found", `no attached vault named "${mount}"`);
    m.dirs.add(rel);
    return JSON.stringify({ ok: true, mount, path: rel });
  }
}

/** Start a loopback stub hub. Resolves once listening on an ephemeral port. */
export function startStubHub(opts: StubHubOptions = {}): Promise<StubHub> {
  const sessions = opts.sessions ?? DEFAULT_SESSIONS;
  const version = opts.version ?? "v1.18.29";
  const requests: string[] = [];
  const authSeen: string[] = [];
  const hostOps: { op: string; body: Record<string, unknown> }[] = [];
  const hostFs = new StubHostFs(opts.hostFiles);
  const json = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
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
    // ── #1267: the host file plane. READ routes mirror the REAL vault-browser
    //    contract (loopback engine, HTTP 200 + {ok,...} bodies). WRITE routes are
    //    the INTENDED contract the provider consumes; withheld under hostReadOnly
    //    to emulate the current real engine (which 404s them — the documented gap).
    const path = req.url ? req.url.split("?")[0] : "";
    const query = req.url ? new URL(req.url, "http://localhost").searchParams : new URLSearchParams();
    if (req.method === "GET" && path === "/amicode/vaults") {
      return json(res, 200, JSON.stringify({ ok: true, mounts: hostFs.listMounts(), error: null }));
    }
    if (req.method === "GET" && path === "/amicode/vault-files") {
      return json(res, 200, hostFs.vaultFilesBody(query.get("mount") ?? undefined));
    }
    if (req.method === "GET" && path === "/amicode/vault-file") {
      return json(res, 200, hostFs.vaultFileBody(query.get("mount") ?? undefined, query.get("path") ?? undefined));
    }
    if (req.method === "POST" && path.startsWith("/amicode/vault-file")) {
      if (opts.hostReadOnly) {
        return json(res, 404, JSON.stringify({ ok: false, error: `no route: ${req.method} ${path}` }));
      }
      void readBody(req).then((body) => {
        const mount = String(body.mount ?? "");
        if (path === "/amicode/vault-file/rename") {
          hostOps.push({ op: "rename", body });
          return json(res, 200, hostFs.rename(mount, String(body.from ?? ""), String(body.to ?? "")));
        }
        if (path === "/amicode/vault-file/delete") {
          hostOps.push({ op: "delete", body });
          return json(res, 200, hostFs.del(mount, String(body.path ?? "")));
        }
        if (path === "/amicode/vault-file/mkdir") {
          hostOps.push({ op: "mkdir", body });
          return json(res, 200, hostFs.mkdir(mount, String(body.path ?? "")));
        }
        if (path === "/amicode/vault-file") {
          hostOps.push({ op: "write", body });
          return json(res, 200, hostFs.write(mount, String(body.path ?? ""), String(body.content ?? "")));
        }
        return json(res, 404, JSON.stringify({ ok: false, error: `no route: ${req.method} ${path}` }));
      });
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
        hostOps,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
