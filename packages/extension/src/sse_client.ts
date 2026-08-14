import * as http from "node:http";
import * as vscode from "vscode";
import type { StatusBarManager } from "./status_bar";

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

export interface SseClientOptions {
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  /** `Authorization` header value for the per-boot server password (#163) —
   *  without it the fork 401s /event and the reconnect loop spins forever.
   *  Never logged; the value exists only on the wire. */
  authorization?: string;
}

export class OpencodeEventClient implements vscode.Disposable {
  private req?: http.ClientRequest;
  private res?: http.IncomingMessage;
  private buf = "";
  private url?: URL;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly opts: SseClientOptions) {}

  connect(serverUrl: URL): void {
    this.url = new URL("/event", serverUrl);
    this.opts.channel.appendLine(`[sse] connecting to ${this.url}`);
    this.openOnce();
  }

  dispose(): void {
    this.disposed = true;
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
          this.opts.channel.appendLine(`[sse] bad status ${res.statusCode}; will retry`);
          this.scheduleReconnect();
          return;
        }
        this.opts.channel.appendLine(`[sse] connected`);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => this.onChunk(chunk));
        res.on("end", () => {
          this.opts.channel.appendLine(`[sse] stream ended; will retry`);
          this.scheduleReconnect();
        });
        res.on("error", (err) => {
          this.opts.channel.appendLine(`[sse] response error: ${err.message}`);
          this.scheduleReconnect();
        });
      },
    );
    req.on("error", (err) => {
      this.opts.channel.appendLine(`[sse] req error: ${err.message}`);
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
    this.buf += chunk;
    // SSE events terminate on a blank line (\n\n).
    let sep: number;
    while ((sep = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep + 2);
      this.handleBlock(block);
    }
  }

  private handleBlock(block: string): void {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
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

  private dispatch(event: { type?: string; properties?: Record<string, unknown> }): void {
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
