import * as http from "node:http";
import * as vscode from "vscode";
import type { StatusBarManager } from "./status_bar";
import { SseLivenessTracker, type SseState } from "./sse_liveness";
import { SseFrameSplitter } from "./amicode_service/sse_frame_splitter";

// ============================================================================
// OpencodeEventClient — Channel 1 of the bidirectional plumbing.
//
// Subscribes to opencode's SSE bus at `${url}/event`. opencode publishes
// session lifecycle, tool execution, and custom plugin events on this stream.
// We route the events of interest to the status bar + Run Inspector.
//
// Wire format (verified against opencode 1.3.x):
//   data: {"type":"session.updated","properties":{...}}\n\n
//   data: {"type":"tool.completed","properties":{"tool":"amico_run_julia",...}}\n\n
//
// Reconnect policy: on disconnect, wait 1s and re-open. We swallow errors —
// callbackServer + filesystem watcher are independent of this channel, so a
// dead SSE doesn't break the demo.
// ============================================================================

/** One parsed stream event (the `data:` payload of an SSE frame). */
export type OpencodeStreamEvent = { type?: string; properties?: Record<string, unknown> };

export interface SseClientOptions {
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  /** `Authorization` header value for the per-boot server password (#163) —
   *  without it the fork 401s /event and the reconnect loop spins forever.
   *  Never logged; the value exists only on the wire. */
  authorization?: string;
  /** Liveness states (L1, #638): fired on every transition. The status bar
   *  is driven automatically from this; this hook is for any other sink. */
  onSseState?: (from: SseState, to: SseState) => void;
  /** #1788 (S3): observe-only event sink — every PARSED event reaches it
   *  immediately, before the built-in routing. A passive consumer (the
   *  followed-session watcher): it must never mutate the stream, its cursor
   *  handling, or this connection. A throwing observer is CONTAINED here —
   *  logged, never propagated into the stream loop. */
  onEvent?: (event: OpencodeStreamEvent) => void;
}

export class OpencodeEventClient implements vscode.Disposable {
  private req?: http.ClientRequest;
  private res?: http.IncomingMessage;
  /** #1790: linear-time frame splitter — scans only the new chunk, carrying a
   *  two-character lookback for a boundary split across chunks.  Handles both
   *  LF (`\n\n`) and CRLF (`\r\n\r\n`) frame endings.  Replaces the quadratic
   *  `buf += chunk; buf.indexOf("\n\n")` pattern the client shipped with. */
  private splitter = new SseFrameSplitter();
  private url?: URL;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private liveness?: SseLivenessTracker;

  constructor(private readonly opts: SseClientOptions) {}

  connect(serverUrl: URL): void {
    this.url = new URL("/event", serverUrl);
    this.opts.channel.appendLine(`[sse] connecting to ${this.url}`);
    // Liveness (L1, #638): frames are the truth; the probe splits a quiet
    // half-open stream from a dead server; every transition reaches the
    // status bar and the caller's hook — "thinking" is never unbacked.
    this.liveness?.dispose();
    this.liveness = new SseLivenessTracker({
      probe: () => this.probeServer(),
      log: (line) => this.opts.channel.appendLine(line),
      onStateChange: (from, to) => {
        this.opts.onSseState?.(from, to);
        this.opts.statusBar?.setSseState(to);
      },
      onReconnectNeeded: () => {
        // half-open: the server is alive but this stream will never speak
        // again — tear it down; the reconnect loop reopens fresh
        try {
          this.req?.destroy();
        } catch {
          /* noop */
        }
        try {
          this.res?.destroy();
        } catch {
          /* noop */
        }
        this.scheduleReconnect();
      },
    });
    this.liveness.start();
    this.openOnce();
  }

  /** The stream's honest state — for callers and tests. */
  get sseState(): SseState {
    return this.liveness?.getState() ?? "connecting";
  }

  /** A short-timeout GET on the server root with the same credential the
   *  stream uses — the STALE branch's dead-or-alive question. */
  private async probeServer(): Promise<boolean> {
    if (!this.url) return false;
    try {
      const r = await fetch(this.url.origin, {
        signal: AbortSignal.timeout(2_000),
        headers: this.opts.authorization ? { Authorization: this.opts.authorization } : undefined,
      });
      return r.status > 0;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.liveness?.dispose();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.req?.destroy();
    } catch {
      /* noop */
    }
    try {
      this.res?.destroy();
    } catch {
      /* noop */
    }
  }

  private openOnce(): void {
    if (this.disposed || !this.url) return;
    const req = http.request(
      {
        hostname: this.url.hostname,
        port: this.url.port,
        path: this.url.pathname,
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...(this.opts.authorization ? { Authorization: this.opts.authorization } : {}),
        },
      },
      (res) => {
        this.res = res;
        if (res.statusCode !== 200) {
          this.liveness?.noteDisconnected();
          this.opts.channel.appendLine(`[sse] bad status ${res.statusCode}; will retry`);
          this.scheduleReconnect();
          return;
        }
        this.opts.channel.appendLine(`[sse] connected`);
        this.liveness?.noteConnected();
        // #1790: reset the splitter on each new connection so a partial frame
        // from a previous connection never bleeds into the next one.
        this.splitter = new SseFrameSplitter();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => this.onChunk(chunk));
        res.on("end", () => {
          this.opts.channel.appendLine(`[sse] stream ended; will retry`);
          this.liveness?.noteDisconnected();
          this.scheduleReconnect();
        });
        res.on("error", (err) => {
          this.opts.channel.appendLine(`[sse] response error: ${err.message}`);
          this.liveness?.noteDisconnected();
          this.scheduleReconnect();
        });
      },
    );
    req.on("error", (err) => {
      this.opts.channel.appendLine(`[sse] req error: ${err.message}`);
      this.liveness?.noteDisconnected();
      this.scheduleReconnect();
    });
    req.end();
    this.req = req;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openOnce();
    }, 1_000);
  }

  private onChunk(chunk: string): void {
    // ANY bytes = the stream is speaking (events or comment-only pings —
    // the liveness signal the old client discarded, #638)
    this.liveness?.noteFrame();
    // #1790: linear-time frame splitting — SseFrameSplitter scans only the new
    // chunk, carrying a two-character lookback for a boundary (`\n\n` or
    // `\r\n\r\n`) split across chunks.  Each whole frame is forwarded to
    // handleBlock verbatim (delimiter included), so `\r\n` line endings inside
    // the frame reach handleBlock intact; handleBlock splits on /\r?\n/.
    for (const frame of this.splitter.push(chunk)) {
      // strip the trailing blank-line delimiter before passing to handleBlock
      this.handleBlock(frame.replace(/\r?\n\r?\n$/, ""));
    }
  }

  private handleBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    let event: { type?: string; properties?: Record<string, unknown> };
    try {
      event = JSON.parse(payload);
    } catch {
      return; /* opencode sometimes sends ping/comment-only blocks */
    }
    this.dispatch(event);
  }

  private dispatch(event: OpencodeStreamEvent): void {
    // #1788 (S3): the observe-only sink first. Contained: a broken observer
    // must never take the shared stream's own routing down with it.
    if (this.opts.onEvent) {
      try {
        this.opts.onEvent(event);
      } catch (err) {
        this.opts.channel.appendLine(`[sse] event observer error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const type = event.type ?? "";
    const props = event.properties ?? {};
    // Light routing: only the events we currently care about. We don't
    // re-publish anything; status bar + inspector are the sinks.
    if (type === "session.idle" || type === "session.updated") {
      // No-op for now; future: surface session activity indicator.
      return;
    }
    if (type === "tool.execute.before" || type === "tool.executing") {
      const tool = String(props.tool ?? "");
      if (tool.includes("amico")) {
        this.opts.channel.appendLine(`[sse] tool starting: ${tool}`);
      }
      return;
    }
    if (type === "tool.execute.after" || type === "tool.completed") {
      const tool = String(props.tool ?? "");
      if (tool.includes("amico")) {
        this.opts.channel.appendLine(`[sse] tool completed: ${tool}`);
      }
      return;
    }
    if (type === "permission.requested") {
      this.opts.channel.appendLine(`[sse] permission requested: ${JSON.stringify(props).slice(0, 200)}`);
      return;
    }
    // Unknown event types — log at debug level only.
    this.opts.channel.appendLine(`[sse] event: ${type}`);
  }
}
