import * as fs from "node:fs";
import * as vscode from "vscode";

// ===========================================================================
// LogTailer — follows an append-only text file (run.log, runs/index) as lines
// are appended, emitting each new line exactly once. Extracted verbatim from
// file_watcher.ts for 1.2 (#57): the multi-run RunsManager runs one tailer per
// live run's run.log PLUS one on the append-only runs/index (discovery).
// ===========================================================================

export interface LogTailerOptions {
  path: string;
  channel: vscode.OutputChannel;
  onLine: (line: string) => void;
  startOffset?: number;
}

export class LogTailer implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private offset = 0;
  private buf = "";
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;
  private attached = false;

  constructor(private readonly opts: LogTailerOptions) {}

  /** Backstop drain (called by the owner's poll). Attaches first if the file
   *  has appeared since start() (the 250ms retry timer may not have fired yet —
   *  same coalesced-FSEvents rationale as the poll itself). attach() sets the
   *  start offset, so it never re-reads lines a replay already consumed. */
  poke(): void {
    if (this.disposed) return;
    if (!this.attached && fs.existsSync(this.opts.path)) this.attach();
    if (this.attached) this.drain();
  }

  start(): void {
    const tryAttach = () => {
      if (this.disposed) return;
      if (fs.existsSync(this.opts.path)) this.attach();
      else this.pollTimer = setTimeout(tryAttach, 250);
    };
    tryAttach();
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try {
      this.watcher?.close();
    } catch {
      /* noop */
    }
    this.watcher = undefined;
  }

  private attach(): void {
    if (this.disposed || this.attached) return;
    // Start where the replay stopped reading (startOffset), not at current EOF —
    // otherwise lines appended between the replay read and this attach are lost.
    this.offset = this.opts.startOffset ?? 0;
    this.attached = true;
    try {
      this.watcher = fs.watch(this.opts.path, { persistent: false }, (event) => {
        if (event === "change") this.drain();
      });
      // Unhandled FSWatcher 'error' would crash the host; the owner's poll
      // (poke) keeps draining even if this watcher dies.
      this.watcher.on("error", (e) => this.opts.channel.appendLine(`[runs] log tail watch error: ${String(e)}`));
    } catch (err) {
      this.opts.channel.appendLine(`[runs] log tail attach failed: ${(err as Error).message}`);
    }
    // Drain immediately to catch lines already written past startOffset.
    this.drain();
  }

  private drain(): void {
    if (this.disposed) return;
    let fd: number;
    try {
      fd = fs.openSync(this.opts.path, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.buf = "";
      }
      if (size === this.offset) return;
      const chunk = Buffer.allocUnsafe(size - this.offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += read;
      this.buf += chunk.subarray(0, read).toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try {
          this.opts.onLine(line);
        } catch (e) {
          this.opts.channel.appendLine(`[runs] onLine threw: ${String(e)}`);
        }
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}
