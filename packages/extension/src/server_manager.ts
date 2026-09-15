import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { serverAuthHeader } from "./server_auth";
import { daemonizeSpawn, freePortIfOurs } from "./server_daemonize";

// ============================================================================
// ServerManager — spawn `opencode serve`, wait for it to come up, expose
// readiness + URL to the rest of the extension.
//
// #1146 (ADR 0020): when a `logFile` is provided the server is spawned
// **detached** with stdout/stderr redirected to that file.  The process
// survives the extension host's exit (reparented to init/launchd).
// `detach()` disposes the log tail without killing; `stop()` is the
// deliberate kill (for Restart / solver-mode switch).
//
// Lifecycle:
//   1. use the configured port, or acquire a free TCP port if none was given
//   2. spawn `opencode serve --hostname 127.0.0.1 --port <port>` with env
//   3. poll http://127.0.0.1:<port>/ until 200 (max 30s)
//   4. start tailing the log file into the output channel (detached path)
//   5. report ready; expose .url + .port + .pid
//   6. on detach: stop tail, forget child (leave running)
//   7. on stop:   SIGTERM, wait, SIGKILL fallback
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
  /** Called after the health probe succeeds and BEFORE onReady fires — the
   *  cold-spawn handshake write hooks in here (#1144, ADR 0020). Receives
   *  the port and the child PID so the handshake record can be stamped. */
  afterHealthy?: (info: { port: number; pid: number }) => void;
  /** Log file path for the detached server's stdout/stderr (#1146, ADR 0020).
   *  When set, the server is spawned detached + unreferenced and its stdio is
   *  redirected to this file. The output channel tails the file. When unset,
   *  the legacy piped-stdio path is used (backward compat for tests). */
  logFile?: string;
}

export class ServerManager {
  private child?: cp.ChildProcess;
  private _port?: number;
  private _pid?: number;
  private _ready = false;
  private _running = false;    // #1183: a daemonized server is running (we hold no ChildProcess handle)
  private _daemonized = false; // #1183: that server was double-forked → stop by PID/port, never by handle
  private readonly _onReady = new vscode.EventEmitter<URL>();
  readonly onReady = this._onReady.event;
  private tailTimer?: ReturnType<typeof setInterval>;
  private tailOffset = 0;

  constructor(private readonly opts: ServerOptions) {}

  get port(): number | undefined {
    return this._port;
  }
  /** The child process PID (undefined when detached or stopped). */
  get pid(): number | undefined {
    return this._pid;
  }
  get url(): URL | undefined {
    return this._port ? new URL(`http://127.0.0.1:${this._port}`) : undefined;
  }
  get ready(): boolean {
    return this._ready;
  }

  async start(): Promise<URL> {
    if (this.child || this._running) {
      throw new Error("opencode server already running");
    }
    const port = this.opts.port ?? (await pickFreePort());
    this._port = port;
    this.opts.channel.appendLine(`[server] spawning opencode serve --port=${port} (cwd=${this.opts.cwd})`);

    // Browser wiring for Google connector (and any MCP OAuth): VS Code remote sets
    // BROWSER to the helper that does `code --openExternal` via VSCODE_IPC_HOOK_CLI.
    // The opencode McpBrowser now respects BROWSER first (fallback to xdg-open),
    // but only if the server inherits it. Explicitly log what we propagate so a
    // "browser doesn't launch" failure is diagnosable from the output channel.
    // Google token path (like Claude): paste a token into the connections panel
    // as with Slack/GitHub — no browser needed when a token is available.
    const browserEnv = process.env.BROWSER ? `BROWSER=${process.env.BROWSER}` : "BROWSER=(unset)";
    const ipcEnv = process.env.VSCODE_IPC_HOOK_CLI ? "VSCODE_IPC_HOOK_CLI=present" : "VSCODE_IPC_HOOK_CLI=(unset)";
    this.opts.channel.appendLine(`[server] browser env: ${browserEnv}, ${ipcEnv}`);
    this.opts.channel.appendLine(`[server] google connector supports token paste (like Claude) + browser OAuth`);

    // #1146 (ADR 0020): --hostname 127.0.0.1 enforces loopback-only binding.
    // The at-rest-password threat model depends on the server being unreachable
    // from off-host.
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
    const logFile = this.opts.logFile;
    let pidForHook: number | undefined;

    if (logFile) {
      // ── Daemonized path (#1183, ADR 0020) ────────────────────────────────
      // Double-fork: a short-lived launcher spawns the server detached and
      // exits at once, so the server reparents to launchd/init (PPID 1) and
      // escapes the extension-host process subtree. A bare `detached:true`
      // does NOT — VS Code reaps the subtree by PID on a window reload
      // (confirmed live: setsid held, the server still died). The launcher
      // REPORTS the server pid (its own child); the launcher pid is never kept.
      fs.mkdirSync(dirname(logFile), { recursive: true });
      let serverPid: number;
      try {
        const res = await daemonizeSpawn({
          binary: this.opts.binary,
          args,
          cwd: this.opts.cwd,
          env: this.opts.env,
          logFile,
        });
        serverPid = res.serverPid;
      } catch (e) {
        this.opts.channel.appendLine(`[server] daemonize failed: ${(e as Error).message}`);
        throw new Error("opencode failed to daemonize — check the 'Amicode — opencode' output channel");
      }
      this._pid = serverPid;
      this._running = true;
      this._daemonized = true;
      pidForHook = serverPid;
      this.opts.channel.appendLine(`[server] daemonized spawn (server pid=${serverPid}, log=${logFile})`);
    } else {
      // ── Legacy piped path (tests without logFile) — unchanged ─────────────
      const piped = cp.spawn(this.opts.binary, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      });
      piped.stdout.on("data", (b: Buffer) => this.opts.channel.append(`[opencode] ${b.toString()}`));
      piped.stderr.on("data", (b: Buffer) => this.opts.channel.append(`[opencode!] ${b.toString()}`));
      this.child = piped;
      this._pid = piped.pid;
      pidForHook = piped.pid;
      piped.on("exit", (code, signal) => {
        this.opts.channel.appendLine(`[server] opencode exited code=${code} signal=${signal}`);
        this._ready = false;
        this.child = undefined;
      });
    }

    // The probe authenticates with the credential WE injected (#163): with
    // OPENCODE_SERVER_PASSWORD armed, the fork 401s an anonymous `GET /`, and
    // a healthy boot would read as a 30s timeout. Derived from the same env
    // the child gets, so probe and server can never disagree.
    const password = this.opts.env.OPENCODE_SERVER_PASSWORD;
    const ready = await waitForHealth(`http://127.0.0.1:${port}/`, 30_000, password ? serverAuthHeader(password) : undefined);
    if (!ready) {
      this.opts.channel.appendLine(`[server] opencode did not become healthy within 30s`);
      await this.stop();
      throw new Error("opencode failed to start within 30s — check the 'Amicode — opencode' output channel");
    }
    this._ready = true;

    // #1146: start tailing the log file into the output channel AFTER health
    // passes — the initial read catches up on all startup output, then the
    // poll handles subsequent lines.
    if (logFile) {
      this.startTailing(logFile);
    }

    // #1144 (ADR 0020): cold-spawn handshake write — the callback runs AFTER
    // health passes and BEFORE onReady fires, so the handshake record is on
    // disk before any consumer (SSE client, chat panel) touches the server.
    if (this.opts.afterHealthy && pidForHook) {
      this.opts.afterHealthy({ port, pid: pidForHook });
    }
    const url = new URL(`http://127.0.0.1:${port}`);
    this.opts.channel.appendLine(`[server] ready at ${url}`);
    this._onReady.fire(url);
    return url;
  }

  // ── Log tailing (#1146) ────────────────────────────────────────────────

  private startTailing(logFile: string) {
    // Catch-up: read everything the server has written so far
    try {
      const existing = fs.readFileSync(logFile, "utf8");
      this.tailOffset = Buffer.byteLength(existing, "utf8");
      if (existing.length > 0) {
        this.opts.channel.append(`[opencode] ${existing}`);
      }
    } catch { /* file may not exist yet */ }

    // Poll for new content
    this.tailTimer = setInterval(() => {
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > this.tailOffset) {
          const buf = Buffer.alloc(stat.size - this.tailOffset);
          const fd = fs.openSync(logFile, "r");
          fs.readSync(fd, buf, 0, buf.length, this.tailOffset);
          fs.closeSync(fd);
          this.tailOffset = stat.size;
          this.opts.channel.append(`[opencode] ${buf.toString("utf8")}`);
        }
      } catch { /* file not ready yet */ }
    }, 200);
  }

  private stopTailing(): void {
    if (this.tailTimer) {
      clearInterval(this.tailTimer);
      this.tailTimer = undefined;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Detach from the server without killing it (#1146/#1183, ADR 0020).
   *  Stops the log tailer and drops our references. A daemonized server is
   *  already reparented to launchd and outlives us by construction — this is
   *  the deactivate/reload path, so it must NEVER kill. */
  detach(): void {
    this.stopTailing();
    this.child = undefined;
    this._running = false;
    this._daemonized = false;
    this._pid = undefined;
    this._ready = false;
  }

  /** Kill the server — for deliberate Restart/Stop and solver-mode switches.
   *  Resolves once the server is actually gone (SIGKILL-bounded) so a caller
   *  restarting onto a fixed port does not race the old process for the socket.
   *  #1183: a daemonized server has no owned handle — kill the discovered PID,
   *  then free the port IFF our server still holds it (covers a not-yet-known
   *  PID or a missed kill, and never touches a foreign holder). */
  async stop(): Promise<void> {
    this.stopTailing();

    if (this._daemonized) {
      const pid = this._pid;
      const port = this._port;
      this._ready = false;
      this._running = false;
      this._daemonized = false;
      this._pid = undefined;
      if (pid !== undefined) {
        this.opts.channel.appendLine(`[server] stopping daemonized opencode (pid=${pid})`);
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        for (let i = 0; i < 12; i++) {
          if (!pidIsAlive(pid)) break;
          await sleep(250);
        }
        if (pidIsAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
          await sleep(300);
        }
      }
      if (port !== undefined) {
        try { await freePortIfOurs(port); } catch { /* best-effort */ }
      }
      return;
    }

    if (!this.child) return;
    this.opts.channel.appendLine(`[server] stopping opencode (pid=${this.child.pid})`);
    const c = this.child;
    this.child = undefined;
    this._ready = false;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch {}
      }, 3_000);
      c.once("exit", () => { clearTimeout(killTimer); resolve(); });
      try { c.kill("SIGTERM"); } catch { clearTimeout(killTimer); resolve(); }
    });
  }
}

/** PID existence check (signal 0 = existence probe, no signal delivered). */
function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
