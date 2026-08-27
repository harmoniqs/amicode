import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as net from "node:net";
import type { Readable } from "node:stream";
import { serverAuthHeader } from "./server_auth";

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

  get port(): number | undefined {
    return this._port;
  }
  get url(): URL | undefined {
    return this._port ? new URL(`http://127.0.0.1:${this._port}`) : undefined;
  }
  get ready(): boolean {
    return this._ready;
  }

  async start(): Promise<URL> {
    if (this.child) {
      throw new Error("opencode server already running");
    }

    let port: number;
    if (this.opts.port) {
      // A fixed port was configured (e.g. amicode.opencodePort = 43117).
      // Verify it's actually free before asking opencode to bind it — on shared
      // remote hosts (SSH) another process (or another Amicode window) may
      // already occupy it.
      const available = await portIsAvailable(this.opts.port);
      if (available) {
        port = this.opts.port;
      } else {
        port = await pickFreePort();
        this.opts.channel.appendLine(
          `[server] configured port ${this.opts.port} is in use — falling back to ephemeral port ${port}`,
        );
        vscode.window.showWarningMessage(
          `Amicode: port ${this.opts.port} was occupied — started on port ${port} instead.`,
        );
      }
    } else {
      port = await pickFreePort();
    }

    this._port = port;
    this.opts.channel.appendLine(`[server] spawning opencode serve --port=${port} (cwd=${this.opts.cwd})`);

    // Browser wiring for Google connector (and any MCP OAuth): VS Code remote sets
    // BROWSER to the helper that does `code --openExternal` via VSCODE_IPC_HOOK_CLI.
    // The opencode McpBrowser now respects BROWSER first (fallback to xdg-open),
    // but only if the server inherits it. Explicitly log what we propagate so a
    // "browser doesn't launch" failure is diagnosable from the output channel.
    // Google token path (like Claude): paste a token into the connections panel
    // as with Slack/GitHub — no browser needed when a token is available.
    const browserEnv = process.env.BROWSER ? `BROWSER=${process.env.BROWSER}` : "BROWSER=(unset)"
    const ipcEnv = process.env.VSCODE_IPC_HOOK_CLI ? "VSCODE_IPC_HOOK_CLI=present" : "VSCODE_IPC_HOOK_CLI=(unset)"
    this.opts.channel.appendLine(`[server] browser env: ${browserEnv}, ${ipcEnv}`)
    this.opts.channel.appendLine(`[server] google connector supports token paste (like Claude) + browser OAuth`)
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

    // The probe authenticates with the credential WE injected (#163): with
    // OPENCODE_SERVER_PASSWORD armed, the fork 401s an anonymous `GET /`, and
    // a healthy boot would read as a 30s timeout. Derived from the same env
    // the child gets, so probe and server can never disagree.
    const password = this.opts.env.OPENCODE_SERVER_PASSWORD;
    const ready = await waitForHealth(`http://127.0.0.1:${port}/`, 30_000, password ? serverAuthHeader(password) : undefined);
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
        try {
          c.kill("SIGKILL");
        } catch {}
      }, 3_000);
      c.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        c.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
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

/** Returns true if the given port can be bound on 127.0.0.1 (i.e. is not in use). */
function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      // EADDRINUSE means something else is on this port; any other error
      // (EACCES, etc.) also means we can't use it.
      resolve(false);
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number, authorization?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // opencode 1.3.x serves a redirect or HTML at /; just probe for any
      // 2xx/3xx response on the base URL with a short timeout.
      const r = await fetchWithTimeout(baseUrl, 500, authorization);
      if (r.ok || (r.status >= 200 && r.status < 400)) return true;
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  return false;
}

async function fetchWithTimeout(url: string, ms: number, authorization?: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: authorization ? { Authorization: authorization } : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
