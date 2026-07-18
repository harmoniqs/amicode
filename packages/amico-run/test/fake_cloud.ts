// packages/amico-run/test/fake_cloud.ts
// Hermetic Δ2/Δ4-shaped server (SHAPE ONLY — Δ4 is not deployed; this fake is
// the executable contract the client is built against; revisit at the live
// smoke, Task 11). One task at a time; mutate `state` mid-test to script the
// run's lifecycle. Also imported (relative, Bundler-style) by the extension's
// Δ9 tests — keep it vscode-free and dependency-free.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeIter {
  iter: number;
  f: string;
  inf_pr: string;
  inf_du: string;
}

export interface FakeState {
  task_status: "Pending" | "Running";
  finished?: { status: "completed" | "failed" | "aborted" };
  liveness: "alive" | "gone";
  iters: FakeIter[]; // Δ4 stats: full history each poll (client dedups on high-water)
  frame?: { iter: number; png_base64: string }; // Δ4 frames: newest only
  framesBroken?: boolean; // 500 the frames endpoint — resolution (a) lane
}

export class FakeCloud {
  readonly token = "test-token-abc";
  readonly taskId = "task-0001";
  state: FakeState = { task_status: "Pending", liveness: "alive", iters: [] };
  submits: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
  submitStatus = 202; // override to 500 etc. for failure lanes (401 comes from a bad token)
  aborts = 0;
  statusPolls = 0;
  base = "";
  private server?: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }

  /** Deterministic sequencing: resolves once the client has status-polled ≥ n times. */
  async waitForPolls(n: number): Promise<void> {
    while (this.statusPolls < n) await new Promise((r) => setTimeout(r, 5));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const authed = req.headers.authorization === `Bearer ${this.token}`;
    if (req.method === "POST" && url === "/solves") {
      this.submits.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>,
      });
      if (!authed) return send(401, { error: "bad credential" });
      if (this.submitStatus !== 202) return send(this.submitStatus, { error: "boom" });
      return send(202, { task_id: this.taskId, status: "Pending" });
    }
    if (!authed) return send(401, { error: "bad credential" });
    if (url === `/solves/${this.taskId}/status`) {
      this.statusPolls++;
      const { task_status, finished, liveness } = this.state;
      return send(200, finished ? { task_status, finished, liveness } : { task_status, liveness });
    }
    if (url === `/solves/${this.taskId}/stats`) return send(200, { iters: this.state.iters });
    if (url === `/solves/${this.taskId}/frames`) {
      if (this.state.framesBroken) return send(500, { error: "frames unavailable" });
      if (!this.state.frame) return send(204);
      return send(200, this.state.frame);
    }
    if (req.method === "POST" && url === `/solves/${this.taskId}/abort`) {
      this.aborts++;
      return send(202, { status: "aborting" });
    }
    return send(404, { error: `no route ${req.method} ${url}` });
  }
}
