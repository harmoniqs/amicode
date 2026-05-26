import * as http from "node:http";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { getInspector } from "./run_inspector";
import { RunOutputWatcher } from "./file_watcher";
import type { ExtensionAction, SolverIterRecord } from "./types";

// ============================================================================
// CallbackServer — Channel 2 of the bidirectional plumbing.
//
// Hosts a small HTTP listener on a free port at activate. URL is passed to
// opencode (and through it to amico-mcp + plugin) via the AMICODE_EXTENSION_URL
// env var. Any of those can POST a JSON ExtensionAction to /action and the
// extension dispatches via VS Code APIs.
//
// Also accepts AMICODE_ITER records on /iter (pushed by amico-mcp as it parses
// spike_solve.jl stdout) and routes them into the Inspector stats row.
// ============================================================================

export interface CallbackServerOptions {
  channel: vscode.OutputChannel;
}

export class CallbackServer implements vscode.Disposable {
  private server?: http.Server;
  private _port?: number;
  private activeWatcher?: RunOutputWatcher;

  constructor(private readonly opts: CallbackServerOptions) {}

  get port(): number | undefined { return this._port; }
  get url(): string | undefined { return this._port ? `http://127.0.0.1:${this._port}` : undefined; }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          this._port = addr.port;
          this.server = server;
          this.opts.channel.appendLine(`[callback] listening on http://127.0.0.1:${addr.port}`);
          resolve(`http://127.0.0.1:${addr.port}`);
        } else {
          reject(new Error("callback server failed to bind"));
        }
      });
    });
  }

  dispose(): void {
    try { this.server?.close(); } catch {}
    this.activeWatcher?.dispose();
    this.activeWatcher = undefined;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Localhost only; we don't expose to the network.
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.endsWith("127.0.0.1") && remote !== "::1") {
      res.writeHead(403); res.end("forbidden"); return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (req.url === "/action") {
          await this.handleAction(data as ExtensionAction, res);
        } else if (req.url === "/iter") {
          this.handleIter(data as SolverIterRecord, res);
        } else if (req.url === "/ping") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(404); res.end("unknown route");
        }
      } catch (e) {
        this.opts.channel.appendLine(`[callback] error: ${String(e)}`);
        res.writeHead(500); res.end(String(e));
      }
    });
  }

  private handleIter(rec: SolverIterRecord, res: http.ServerResponse): void {
    getInspector()?.postIterationRecord(rec);
    res.writeHead(204); res.end();
  }

  private async handleAction(action: ExtensionAction, res: http.ServerResponse): Promise<void> {
    this.opts.channel.appendLine(`[callback] action: ${action.kind}`);
    switch (action.kind) {
      case "open-file": {
        const uri = vscode.Uri.file(action.path);
        const col = action.viewColumn === "beside" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
        await vscode.window.showTextDocument(uri, { preview: action.preview ?? false, viewColumn: col });
        res.writeHead(200); res.end("ok");
        return;
      }
      case "show-notification": {
        if (action.level === "warn") {
          vscode.window.showWarningMessage(action.message);
        } else if (action.level === "error") {
          vscode.window.showErrorMessage(action.message);
        } else {
          vscode.window.showInformationMessage(action.message);
        }
        res.writeHead(200); res.end("ok");
        return;
      }
      case "refresh-tree": {
        await vscode.commands.executeCommand(`amicode.${action.tree}.refresh`);
        res.writeHead(200); res.end("ok");
        return;
      }
      case "show-quick-pick": {
        const choice = await vscode.window.showQuickPick(action.choices, { placeHolder: action.question, ignoreFocusOut: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ replyTo: action.replyTo, choice: choice ?? null }));
        return;
      }
      case "run-state": {
        // Plugin/MCP telling us a solve started or completed.
        if (action.state === "starting" || action.state === "running") {
          this.activeWatcher?.dispose();
          this.activeWatcher = new RunOutputWatcher(action.outputDir);
          this.activeWatcher.start();
          getInspector()?.reveal();
        } else if (action.state === "completed" || action.state === "failed") {
          // Keep watcher alive briefly so final.png + result.toml events flush.
          setTimeout(() => {
            this.activeWatcher?.dispose();
            this.activeWatcher = undefined;
          }, 2000);
          // Notification with quick action to view result
          const resultPath = path.join(action.outputDir, "result.toml");
          if (fs.existsSync(resultPath)) {
            const txt = fs.readFileSync(resultPath, "utf8");
            const fid = (txt.match(/fidelity\s*=\s*([\d.eE+-]+)/) ?? [])[1];
            vscode.window.showInformationMessage(`Amicode run ${action.runId}: F=${fid ?? "?"} (${action.state})`);
          }
        }
        res.writeHead(200); res.end("ok");
        return;
      }
      case "open-inspector": {
        getInspector()?.reveal();
        res.writeHead(200); res.end("ok");
        return;
      }
      default: {
        res.writeHead(400); res.end("unknown action");
      }
    }
  }
}
