// host_file_client.ts — #1267 (fleet client: native Explorer over amico-host://).
//
// The PURE core of the amico-host:// FileSystemProvider. It speaks the host file
// plane over the ALREADY-PROXIED /amicode/* relay (the merged #1261/#1262 work):
// the transport hands it a resolved base URL + the Authorization header the relay
// translates to the hub mint, and this client maps FileSystemProvider operations
// onto host routes, decodes the responses, and translates outcomes into typed
// HostFsError codes the thin vscode adapter maps to vscode.FileSystemError.
//
// TWO DELIBERATE PROPERTIES, both load-bearing for the issue's honesty invariants:
//
//   1. NO `node:fs` IMPORT, NO `vscode` IMPORT. The client can ONLY reach the
//      host through the injected transport. An unreachable host therefore CANNOT
//      silently become a local-disk read (AC5): there is no local-disk code path
//      to fall back to. `baseUrl() === undefined` throws HubDown before any fetch.
//
//   2. HONEST READ/WRITE ASYMMETRY. The READ plane (list/read/stat) maps onto the
//      REAL vault-browser contract the engine already serves —
//        GET /amicode/vaults            → the host's mounts (top-level dirs)
//        GET /amicode/vault-files?mount → a mount's FLAT recursive file list
//        GET /amicode/vault-file?…      → one file's content (+ size)
//      so ACs 1/2-read/5/6 are backed by the real engine. The WRITE plane
//      (write/rename/delete/mkdir) maps onto the INTENDED host mutation routes
//        POST /amicode/vault-file             (write)
//        POST /amicode/vault-file/rename
//        POST /amicode/vault-file/delete
//        POST /amicode/vault-file/mkdir
//      which the real engine does NOT yet serve. When a route is absent the host
//      404s and this client surfaces an explicit RouteAbsent — never a fabricated
//      success, never a local write. Green here against the stub-hub that serves
//      them; the real-engine follow-up is documented in the issue (#1267).
//
// NOTE (content encoding): the vault-file read contract carries text `content`;
// this client round-trips utf8. Binary files are a follow-up alongside the write
// route (the read route reports `not_text` for them today).

/** The typed failure vocabulary the vscode adapter maps to FileSystemError. */
export type HostFsErrorCode =
  | "FileNotFound"
  | "FileExists"
  | "NoPermissions"
  | "HubDown" // the host is unreachable — the honest degraded posture (AC5)
  | "RouteAbsent" // the host lacks this route (the #1267 host write-route gap)
  | "NotADirectory"
  | "IsADirectory"
  | "Unknown";

export class HostFsError extends Error {
  constructor(
    readonly code: HostFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostFsError";
  }
}

export type HostFileType = "file" | "directory";
export interface HostDirEntry {
  name: string;
  type: HostFileType;
  size: number;
}
export interface HostStat {
  type: HostFileType;
  size: number;
}

/** The proxied-transport seam: a resolved base URL (undefined = tunnel down →
 *  HubDown) and the Authorization header value the relay injects/translates. The
 *  `fetch` override is for tests; production uses the global. */
export interface HostFileTransport {
  baseUrl(): string | undefined;
  authHeader(): string | undefined;
  fetch?: typeof fetch;
}

interface ParsedPath {
  mount: string | undefined; // undefined = the scheme root (lists mounts)
  rel: string; // "" = the mount root
}

interface VaultFileEntry {
  path: string;
  name: string;
  size: number;
  readable: boolean;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Parse an amico-host URI path ("/mount/rel/sub") into its mount + rel parts.
 *  Leading/trailing slashes are tolerated; segments are not otherwise decoded
 *  (the caller passes already-decoded path segments). */
export function parseHostPath(uriPath: string): ParsedPath {
  const trimmed = uriPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return { mount: undefined, rel: "" };
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { mount: trimmed, rel: "" };
  return { mount: trimmed.slice(0, slash), rel: trimmed.slice(slash + 1) };
}

/** Classify an ok:false `error` body string (the vault-browser code prefixes)
 *  into a HostFsError code. */
function classifyErrorBody(error: string): HostFsErrorCode {
  const code = error.split(":")[0]?.trim();
  switch (code) {
    case "not_found":
      return "FileNotFound";
    case "forbidden":
      return "NoPermissions";
    case "exists":
    case "file_exists":
      return "FileExists";
    default:
      return "Unknown";
  }
}

/** The structural host-filesystem contract the vscode adapter depends on — so
 *  the adapter can be unit-tested against a fake without the HTTP client. */
export interface HostFs {
  readDirectory(path: string): Promise<HostDirEntry[]>;
  stat(path: string): Promise<HostStat>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, opts?: { create?: boolean; overwrite?: boolean }): Promise<void>;
  rename(from: string, to: string, opts?: { overwrite?: boolean }): Promise<void>;
  delete(path: string, opts?: { recursive?: boolean }): Promise<void>;
  createDirectory(path: string): Promise<void>;
}

export class HostFileClient implements HostFs {
  constructor(private readonly transport: HostFileTransport) {}

  private get fetchImpl(): typeof fetch {
    return this.transport.fetch ?? fetch;
  }

  /** One proxied request. Throws HostFsError on any non-success outcome; returns
   *  the parsed ok:true body otherwise. `baseUrl() === undefined` is HubDown and
   *  is thrown BEFORE any fetch — the structural no-local-fallback guarantee. */
  private async request(
    method: "GET" | "POST",
    routePath: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const base = this.transport.baseUrl();
    if (base === undefined || base === "") {
      throw new HostFsError("HubDown", "fleet host unreachable — no upstream bound (tunnel down)");
    }
    const url = new URL(routePath, base.endsWith("/") ? base : base + "/");
    // routePath is absolute ("/amicode/...") so replace, don't append, the path.
    url.pathname = routePath;
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = {};
    const auth = this.transport.authHeader();
    if (auth) headers["Authorization"] = auth;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch {
      // connection refused / reset / timeout — the honest degraded posture, never
      // an error dump and never a local read.
      throw new HostFsError("HubDown", "fleet host unreachable — transport failure");
    }

    if (res.status === 503) {
      throw new HostFsError("HubDown", "fleet host unreachable — hub down (503)");
    }
    if (res.status === 404) {
      // The route is not served. For the read plane a MISSING FILE comes back as
      // HTTP 200 + {ok:false,"not_found"} — so a raw 404 means the ROUTE is
      // absent: the honest host-side write-route gap (#1267), never a local write.
      throw new HostFsError("RouteAbsent", `host route not available: ${method} ${routePath}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HostFsError("NoPermissions", `host refused the request (${res.status})`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
      throw new HostFsError("Unknown", `host returned an unparseable body (${res.status})`);
    }
    if (parsed.ok === false) {
      const error = typeof parsed.error === "string" ? parsed.error : "unknown error";
      throw new HostFsError(classifyErrorBody(error), error);
    }
    if (!res.ok) {
      throw new HostFsError("Unknown", `host error (${res.status})`);
    }
    return parsed;
  }

  /** GET /amicode/vaults → the host's mounts, as top-level directory entries. */
  private async listMounts(): Promise<HostDirEntry[]> {
    const body = await this.request("GET", "/amicode/vaults");
    const mounts = Array.isArray(body.mounts) ? body.mounts : [];
    return mounts
      .map((m) => (m as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ name: id, type: "directory" as const, size: 0 }));
  }

  /** GET /amicode/vault-files?mount → the mount's FLAT recursive file list. */
  private async listFiles(mount: string): Promise<VaultFileEntry[]> {
    const body = await this.request("GET", "/amicode/vault-files", { query: { mount } });
    const files = Array.isArray(body.files) ? body.files : [];
    return files.filter(
      (f): f is VaultFileEntry =>
        !!f && typeof (f as VaultFileEntry).path === "string" && typeof (f as VaultFileEntry).size === "number",
    );
  }

  /** Synthesize one directory's immediate children from the mount's flat list. */
  private static childrenOf(files: VaultFileEntry[], rel: string): HostDirEntry[] {
    const prefix = rel === "" ? "" : rel + "/";
    const dirs = new Set<string>();
    const out: HostDirEntry[] = [];
    for (const f of files) {
      if (prefix !== "" && !f.path.startsWith(prefix)) continue;
      const remainder = f.path.slice(prefix.length);
      if (remainder === "") continue;
      const slash = remainder.indexOf("/");
      if (slash === -1) {
        out.push({ name: remainder, type: "file", size: f.size });
      } else {
        dirs.add(remainder.slice(0, slash));
      }
    }
    for (const d of dirs) out.push({ name: d, type: "directory", size: 0 });
    return out;
  }

  async readDirectory(path: string): Promise<HostDirEntry[]> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined) return this.listMounts();
    return HostFileClient.childrenOf(await this.listFiles(mount), rel);
  }

  async stat(path: string): Promise<HostStat> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined) return { type: "directory", size: 0 }; // the scheme root
    if (rel === "") {
      // a mount root — confirm it exists (listFiles throws FileNotFound otherwise)
      await this.listFiles(mount);
      return { type: "directory", size: 0 };
    }
    const files = await this.listFiles(mount);
    const file = files.find((f) => f.path === rel);
    if (file) return { type: "file", size: file.size };
    if (files.some((f) => f.path.startsWith(rel + "/"))) return { type: "directory", size: 0 };
    throw new HostFsError("FileNotFound", `no such path on host: ${path}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined || rel === "") {
      throw new HostFsError("IsADirectory", `not a file: ${path}`);
    }
    const body = await this.request("GET", "/amicode/vault-file", { query: { mount, path: rel } });
    const content = typeof body.content === "string" ? body.content : "";
    return encoder.encode(content);
  }

  async writeFile(path: string, content: Uint8Array, opts: { create?: boolean; overwrite?: boolean } = {}): Promise<void> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined || rel === "") throw new HostFsError("IsADirectory", `not a file: ${path}`);
    await this.request("POST", "/amicode/vault-file", {
      body: { mount, path: rel, content: decoder.decode(content), create: opts.create ?? true, overwrite: opts.overwrite ?? true },
    });
  }

  async rename(from: string, to: string, opts: { overwrite?: boolean } = {}): Promise<void> {
    const a = parseHostPath(from);
    const b = parseHostPath(to);
    if (a.mount === undefined || b.mount === undefined) throw new HostFsError("NoPermissions", "cannot rename a mount root");
    if (a.mount !== b.mount) {
      // cross-mount move is not expressible on the mount-scoped host contract
      throw new HostFsError("NoPermissions", "cross-mount rename is not supported");
    }
    await this.request("POST", "/amicode/vault-file/rename", {
      body: { mount: a.mount, from: a.rel, to: b.rel, overwrite: opts.overwrite ?? false },
    });
  }

  async delete(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined || rel === "") throw new HostFsError("NoPermissions", "cannot delete a mount root");
    await this.request("POST", "/amicode/vault-file/delete", {
      body: { mount, path: rel, recursive: opts.recursive ?? true },
    });
  }

  async createDirectory(path: string): Promise<void> {
    const { mount, rel } = parseHostPath(path);
    if (mount === undefined || rel === "") throw new HostFsError("NoPermissions", "cannot create a mount root");
    await this.request("POST", "/amicode/vault-file/mkdir", { body: { mount, path: rel } });
  }
}
