// APP SHELF (#822, the fork-cutover static slice): static serving of the
// built app-bundle dist from the amicode service's origin — the piece that
// lets the framed amicode app come from the extension service instead of the
// fork binary's origin. Pattern lifted from the telaio file-server loops
// (19–20): SPA fallback for GETs that accept HTML, correct content types for
// asset requests, path-traversal refusal, and an HONEST needs-setup
// placeholder when no dist is present (never a silent 404-as-app — a missing
// build must read as a missing build, not as a broken app).
//
// vscode-free on purpose (the service's founding discipline): the dist root
// is RESOLVED by the caller (wiring reads the dev-override setting and the
// extension root) and handed in; this module only serves what it is given.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";

/** The needs-setup placeholder's honest marker — the probe asserts the LIVE
 *  dist never serves it (a served placeholder means the dist did not reach
 *  the shelf). */
export const APP_SHELF_NEEDS_SETUP_MARKER = "amicode-app-shelf-needs-setup";

export interface AppShelfResult {
  status?: number;
  /** Assets ship as utf8 strings when they're text (js/css/svg/html), Buffers
   *  when they're binary (icons/fonts/wasm) — res.end takes both. */
  body: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

/** The dev override wins; the packaged dist rides the extension at
 *  <root>/dist/app (the fetch:opencode precedent for a build product riding
 *  the VSIX — build_app_bundle.mjs stages it there). Pure path logic, so the
 *  wiring tests exercise it without vscode. */
export function resolveAppDistRoot(override: string, extensionRoot: string): string {
  const trimmed = (override ?? "").trim();
  if (trimmed !== "") return trimmed;
  return join(extensionRoot, "dist", "app");
}

// The asset kinds a vite build emits (plus the icons the index references).
// Anything unknown falls back to octet-stream — the browser sniffs, and a
// wrong text/html on an asset is the failure mode that actually matters
// (it turns a script into a document).
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const ext = dot === -1 ? "" : pathname.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function needsSetupHtml(): string {
  // The honest "no app here" page: names what is missing and both fixes
  // (build the dist, or point the override setting at one). Served 200 so a
  // browser (the iframe) renders it — the placeholder IS the app surface's
  // honest state, not an error to trap.
  return `<!doctype html>
<html><head><title>Amicode — app not built</title></head>
<body style="font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem; color: #eee; background: #1e1e1e;">
<h1>Amicode app not built</h1>
<p>${APP_SHELF_NEEDS_SETUP_MARKER}</p>
<p>The extension service is up, but no app-bundle dist is present, so there is nothing to serve at this origin.</p>
<ul>
<li>Package path: run <code>pnpm --filter amicode run build:app</code> (materialize → bun install → vite build), which stages the dist into <code>dist/app</code> inside the extension.</li>
<li>Dev override: set <code>amicode.appBundleDir</code> to a built app dist directory.</li>
</ul>
<p>The /amicode/* API surface is unaffected — only the app UI is absent.</p>
</body></html>
`;
}

export interface AppShelfOptions {
  /** The built app dist root (must hold index.html to count as present). */
  distRoot?: string;
}

export class AppShelf {
  private readonly distRoot: string | undefined;

  constructor(opts: AppShelfOptions = {}) {
    this.distRoot = opts.distRoot;
  }

  /** Does the configured root hold a servable dist? (checked per request —
   *  a dev override dir appearing mid-session needs no re-boot.) */
  private distPresent(): boolean {
    return !!this.distRoot && existsSync(join(this.distRoot, "index.html"));
  }

  /** Refuse traversal BEFORE anything else: a hostile probe gets the honest
   *  403 regardless of whether a dist is present. Decoding happens here so
   *  the encoded form (%2e%2e) is as dead as the literal one. */
  private resolveUnderRoot(pathname: string): string | { traversal: true } {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { traversal: true };
    }
    if (decoded.includes("\0")) return { traversal: true };
    const root = resolvePath(this.distRoot!);
    const target = resolvePath(root, "." + decoded.replace(/\\/g, "/"));
    if (target !== root && !target.startsWith(root + sep)) return { traversal: true };
    return target;
  }

  /**
   * Serve one request from the shelf, or return undefined when the request
   * is NOT the shelf's business (the caller falls through to the engine
   * proxy). Precedence per #822: exact /amicode/* routes outrank the shelf
   * (the caller checks them first); a shelf hit outranks the proxy.
   *
   *   - non-GET          → undefined (the proxy owns it)
   *   - traversal         → 403 (refused outright)
   *   - dist present:
   *       /               → index.html (the origin document)
   *       existing file   → the file, with its content type
   *       GET + accepts HTML → index.html (SPA fallback)
   *       otherwise       → undefined (API surface → the proxy)
   *   - dist missing:
   *       / or GET + accepts HTML → the needs-setup placeholder
   *       otherwise       → undefined (API GETs keep honest non-HTML answers)
   */
  handle(method: string, pathname: string, accept: string): AppShelfResult | undefined {
    if (method !== "GET") return undefined;
    if (this.distPresent()) {
      const under = this.resolveUnderRoot(pathname);
      if (typeof under !== "string") {
        return { status: 403, body: JSON.stringify({ ok: false, error: "forbidden" }), contentType: "application/json" };
      }
      const index = join(this.distRoot!, "index.html");
      if (under === resolvePath(index) || !existsSync(under) || !statSync(under).isFile()) {
        // Not a file on disk: SPA fallback for document GETs only — the API
        // surface keeps honest answers (falls to the proxy), never HTML.
        if (acceptsHtml(accept) || pathname === "/") {
          return { body: readFileSync(index, "utf8"), contentType: "text/html; charset=utf-8" };
        }
        return undefined;
      }
      const contentType = contentTypeFor(under);
      const raw = readFileSync(under);
      return { body: contentType.startsWith("text/") ? raw.toString("utf8") : raw, contentType };
    }
    // No dist (or no root configured): the honest needs-setup placeholder
    // for document GETs — never a silent 404-as-app.
    if (pathname === "/" || acceptsHtml(accept)) {
      return { body: needsSetupHtml(), contentType: "text/html; charset=utf-8" };
    }
    return undefined;
  }
}

function acceptsHtml(accept: string): boolean {
  return accept.includes("text/html");
}
