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
  pulse?: Array<{ raw: string }>; // Δ4 pulse: AMICODE_PULSE_META + AMICODE_PULSE lines, full history each poll
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
    // Artifact bytes, deliberately served BEFORE the auth guard: the real frames
    // endpoint returns a PRESIGNED S3 url, and the client fetches it with no
    // Authorization header because the signature itself is the credential.
    // Guarding this would make the fake reject what the real bucket accepts.
    if (req.method === "GET" && url.startsWith(`/artifacts/${this.taskId}/`)) {
      if (!this.state.frame) return send(404, { error: "no frame" });
      const png = Buffer.from(this.state.frame.png_base64, "base64");
      res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
      return void res.end(png);
    }
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
    // ── WIRE SHAPES MIRROR THE LIVE API ────────────────────────────────────────
    // These two used to serve `{iters}` and `{iter, png_base64}`, which is NOT
    // what the deployed service returns. The client read the fake's shapes, so
    // every test passed while every real cloud solve produced zero iters and zero
    // frames locally — the run inspector stayed empty and nothing failed loudly.
    // Verified against task 419a57e6 on staging (2026-07-28). Keep these matching
    // the live payloads; a fake that agrees with the client instead of the server
    // proves nothing.
    if (url === `/solves/${this.taskId}/stats`) {
      return send(200, { task_id: this.taskId, stats: this.state.iters, submitter: "test" });
    }
    // pulse mirrors stats' shape: {task_id, pulse: [{raw}], submitter}, where the
    // cloud greps AMICODE_PULSE_META + AMICODE_PULSE lines out of the S3 run.log
    // (never JSON, so always {raw}). Full history each poll — the client dedups.
    if (url === `/solves/${this.taskId}/pulse`) {
      return send(200, { task_id: this.taskId, pulse: this.state.pulse ?? [], submitter: "test" });
    }
    if (url === `/solves/${this.taskId}/frames`) {
      if (this.state.framesBroken) return send(500, { error: "frames unavailable" });
      if (!this.state.frame) return send(204);
      const key = `test/${this.taskId}/iter_${String(this.state.frame.iter).padStart(5, "0")}.png`;
      return send(200, {
        task_id: this.taskId,
        iter: this.state.frame.iter,
        key,
        url: `${this.base}/artifacts/${this.taskId}/iter_${this.state.frame.iter}.png`,
        submitter: "test",
      });
    }
    if (req.method === "POST" && url === `/solves/${this.taskId}/abort`) {
      this.aborts++;
      return send(202, { status: "aborting" });
    }
    return send(404, { error: `no route ${req.method} ${url}` });
  }
}
