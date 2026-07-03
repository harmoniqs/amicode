import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as net from "node:net";
import type { Readable } from "node:stream";

// ============================================================================
// ServerManager — spawn `opencode serve --port=N`, wait for it to come up,
// expose readiness + URL to the rest of the extension. Pattern adapted from
// the opencode-v2 decompiled extension (handover §6).
//
// Lifecycle:
//   1. use the configured port, or acquire a free TCP port if none was given
//   2. spawn `opencode serve --port=<port>` with env injected
//   3. poll http://127.0.0.1:<port>/health until 200 (max 30s)
//   4. report ready; expose .url + .port + .child
//   5. on dispose: SIGTERM the child, wait briefly, SIGKILL fallback
// ============================================================================

export interface ServerOptions {
  /** opencode binary name or absolute path. */
  binary: string;
  /** cwd for opencode — opencode reads project config from here. */
  cwd: string;
  /** env vars to inject into the opencode process (e.g. OPENCODE_CONFIG_CONTENT
   *  for the instructions/permission merge, and PATH augmentation so amico-run
   *  resolves). */
  env: Record<string, string>;
  /** OutputChannel for opencode stdout/stderr capture. */
  channel: vscode.OutputChannel;
  /** Fixed port to serve on. 0 (default) picks a free ephemeral port each start. */
  port?: number;
}

export class ServerManager {
  private child?: cp.ChildProcessByStdio<null, Readable, Readable>;
  private _port?: number;
  private _ready = false;
  private readonly _onReady = new vscode.EventEmitter<URL>();
  readonly onReady = this._onReady.event;

  constructor(private readonly opts: ServerOptions) {}

  get port(): number | undefined { return this._port; }
  get url(): URL | undefined { return this._port ? new URL(`http://127.0.0.1:${this._port}`) : undefined; }
  get ready(): boolean { return this._ready; }

  async start(): Promise<URL> {
    if (this.child) {
      throw new Error("opencode server already running");
    }
    const port = this.opts.port ?? (await pickFreePort());
    this._port = port;
    this.opts.channel.appendLine(`[server] spawning opencode serve --port=${port} (cwd=${this.opts.cwd})`);

    const child = cp.spawn(this.opts.binary, ["serve", "--port", String(port)], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (b: Buffer) => this.opts.channel.append(`[opencode] ${b.toString()}`));
    child.stderr.on("data", (b: Buffer) => this.opts.channel.append(`[opencode!] ${b.toString()}`));
    child.on("exit", (code, signal) => {
      this.opts.channel.appendLine(`[server] opencode exited code=${code} signal=${signal}`);
      this._ready = false;
      this.child = undefined;
    });

    const ready = await waitForHealth(`http://127.0.0.1:${port}/`, 30_000);
    if (!ready) {
      this.opts.channel.appendLine(`[server] opencode did not become healthy within 30s`);
      this.stop();
      throw new Error("opencode failed to start within 30s — check the 'Amicode — opencode' output channel");
    }
    this._ready = true;
    const url = new URL(`http://127.0.0.1:${port}`);
    this.opts.channel.appendLine(`[server] ready at ${url}`);
    this._onReady.fire(url);
    return url;
  }

  /** Resolves once the child has actually exited (bounded by the SIGKILL fallback) —
   *  callers restarting onto a fixed port must await this or the new spawn can race
   *  the old process for the socket. */
  stop(): Promise<void> {
    if (!this.child) return Promise.resolve();
    this.opts.channel.appendLine(`[server] stopping opencode (pid=${this.child.pid})`);
    const c = this.child;
    this.child = undefined;
    this._ready = false;
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch {}
      }, 3_000);
      c.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try { c.kill("SIGTERM"); } catch { clearTimeout(killTimer); resolve(); }
    });
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new Error("could not pick free port"));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // opencode 1.3.x serves a redirect or HTML at /; just probe for any
      // 2xx/3xx response on the base URL with a short timeout.
      const r = await fetchWithTimeout(baseUrl, 500);
      if (r.ok || (r.status >= 200 && r.status < 400)) return true;
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  return false;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
