import {
  parseQueue,
  parseHistory,
  parseConfigVersions,
  parseConfigVersion,
  parseJob,
  type AbstractJobServer,
  type ConfigVersion,
  type Health,
  type HistoryFilters,
  type Job,
  type QueueView,
  type Result,
  type SubmitRequest,
} from "./qick_job_server";

// ============================================================================
// QICK job-server HTTP/MCP clients — Spec A §2.3 (adapters) + §5.2 (entitlement).
//
//   SchusterJobServer     — impl #1, Node `fetch` → the multimode `job_server`
//                            FastAPI (submit/queue/history/status/cancel +
//                            config-versioning + health). Endpoint from the
//                            environment card's keyed endpoints[role=job_server]
//                            pointer (never credentials — §3.1 / L0 §2.5).
//   SnowbirdMcpJobServer  — impl #2, the same verbs onto Snowbird's QICK MCP
//                            tool calls (experiment.payload.tool).
//
// Both are NEVER-REJECT (§2.3): every call returns Result<T> — a dead tunnel /
// 500 / timeout / malformed body degrades the view, never crashes the session.
// vscode-free (only Node fetch / an injected runner) so it is unit-testable.
// ============================================================================

/** Minimal `fetch` surface we use — injectable so tests drive a stub. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface SchusterOptions {
  /** Base URL resolved from the environment card's endpoints[role=job_server].ptr. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function err<T>(error: string): Result<T> {
  return { ok: false, error };
}

/** Never-throw health parser (kept local — the health shape is client-specific). */
function parseHealth(v: unknown): Health {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const stats = o.stats && typeof o.stats === "object" ? (o.stats as Record<string, unknown>) : {};
  return {
    ok: o.ok !== false,
    stats: {
      pending: typeof stats.pending === "number" ? stats.pending : 0,
      running: typeof stats.running === "number" ? stats.running : 0,
    },
    capabilities: Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === "string") : undefined,
    channels: Array.isArray(o.channels) ? o.channels.filter((c): c is string => typeof c === "string") : undefined,
  };
}

export class SchusterJobServer implements AbstractJobServer {
  constructor(private readonly opts: SchusterOptions) {}

  private get fetchImpl(): FetchLike {
    return this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** One never-reject round trip: fetch → status check → JSON → parse. Any
   *  failure (network throw, non-2xx, malformed body) → {ok:false, error}. */
  private async req<T>(
    method: string,
    path: string,
    parse: (json: unknown) => T,
    body?: unknown,
  ): Promise<Result<T>> {
    try {
      const res = await this.fetchImpl(this.opts.baseUrl + path, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return err(`http_${res.status}: ${method} ${path}`);
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        return err(`parse_error: ${method} ${path}: ${(e as Error).message}`);
      }
      return ok(parse(json));
    } catch (e) {
      return err(`network_error: ${method} ${path}: ${(e as Error).message}`);
    }
  }

  async submit(reqBody: SubmitRequest): Promise<Result<{ job_id: string }>> {
    return this.req("POST", "/jobs/submit", (j) => {
      const id = j && typeof j === "object" ? (j as Record<string, unknown>).job_id : undefined;
      return { job_id: typeof id === "string" ? id : "" };
    }, reqBody);
  }

  async queue(): Promise<Result<QueueView>> {
    return this.req("GET", "/jobs/queue", parseQueue);
  }

  async history(filters: HistoryFilters): Promise<Result<Job[]>> {
    const qs = new URLSearchParams();
    if (filters.user) qs.set("user", filters.user);
    if (filters.status) qs.set("status", filters.status);
    if (filters.limit !== undefined) qs.set("limit", String(filters.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.req("GET", `/jobs/history${suffix}`, parseHistory);
  }

  async status(jobId: string): Promise<Result<Job>> {
    const r = await this.req("GET", `/jobs/${encodeURIComponent(jobId)}`, (j) => parseJob(j));
    if (!r.ok) return r;
    if (!r.value) return err(`parse_error: malformed job ${jobId}`);
    return ok(r.value);
  }

  async cancel(jobId: string): Promise<Result<void>> {
    return this.req("DELETE", `/jobs/${encodeURIComponent(jobId)}`, () => undefined);
  }

  async configVersions(type: string): Promise<Result<ConfigVersion[]>> {
    return this.req("GET", `/config/versions?type=${encodeURIComponent(type)}`, parseConfigVersions);
  }

  async mainConfig(type: string): Promise<Result<ConfigVersion | undefined>> {
    return this.req("GET", `/config/main?type=${encodeURIComponent(type)}`, parseConfigVersion);
  }

  async pushConfig(type: string, payload: unknown): Promise<Result<ConfigVersion>> {
    const r = await this.req("POST", "/config/push", (j) => parseConfigVersion(j), { type, payload });
    if (!r.ok) return r;
    if (!r.value) return err("parse_error: push_config returned no version");
    return ok(r.value);
  }

  async setMain(type: string, versionId: string): Promise<Result<void>> {
    return this.req("POST", "/config/main", () => undefined, { type, version_id: versionId });
  }

  async health(): Promise<Result<Health>> {
    return this.req("GET", "/health", parseHealth);
  }
}

// --------------------------------------------------------------------------
// SnowbirdMcpJobServer — the contract verbs onto Snowbird's QICK MCP tool calls.
// Snowbird's MCP surface is a set of SYNCHRONOUS named measurement tools, so
// there is no persistent job queue: submit dispatches the tool named in the
// experiment payload; queue/history are empty (idle-safe); the job store verbs
// are unsupported but degrade gracefully (never-reject).
// --------------------------------------------------------------------------

export type McpToolCaller = (tool: string, args: unknown) => Promise<unknown>;

export interface SnowbirdMcpOptions {
  callTool: McpToolCaller;
  capabilities?: string[];
  channels?: string[];
}

export class SnowbirdMcpJobServer implements AbstractJobServer {
  private jobCounter = 0;
  constructor(private readonly opts: SnowbirdMcpOptions) {}

  async submit(reqBody: SubmitRequest): Promise<Result<{ job_id: string }>> {
    const payload = reqBody.experiment.payload as Record<string, unknown> | undefined;
    const tool = payload && typeof payload.tool === "string" ? payload.tool : undefined;
    if (!tool) return err("bad_request: mcp experiment payload has no `tool`");
    try {
      await this.opts.callTool(tool, payload);
      return ok({ job_id: `MCP-${++this.jobCounter}` });
    } catch (e) {
      return err(`mcp_error: ${tool}: ${(e as Error).message}`);
    }
  }

  async queue(): Promise<Result<QueueView>> {
    // MCP tools are synchronous — no persistent queue → always idle-safe.
    return ok({ running: undefined, pending: [] });
  }

  async history(): Promise<Result<Job[]>> {
    return ok([]);
  }

  async status(jobId: string): Promise<Result<Job>> {
    return err(`unsupported: mcp adapter has no job store (${jobId})`);
  }

  async cancel(): Promise<Result<void>> {
    return err("unsupported: mcp tool calls are synchronous, nothing to cancel");
  }

  async configVersions(): Promise<Result<ConfigVersion[]>> {
    return ok([]);
  }

  async mainConfig(): Promise<Result<ConfigVersion | undefined>> {
    return ok(undefined);
  }

  async pushConfig(): Promise<Result<ConfigVersion>> {
    return err("unsupported: mcp config write-back is a Spec B deliverable");
  }

  async setMain(): Promise<Result<void>> {
    return err("unsupported: mcp config write-back is a Spec B deliverable");
  }

  async health(): Promise<Result<Health>> {
    return ok({
      ok: true,
      stats: { pending: 0, running: 0 },
      capabilities: this.opts.capabilities,
      channels: this.opts.channels,
    });
  }
}

// --------------------------------------------------------------------------
// Entitlement predicate (§5.2) — the AUTHORITATIVE gate is package resolution:
// the private Intonatissimo package resolving in the target Julia environment
// (i.e. the qilc strategy can actually run). The job server's health()
// capabilities flag is only an advisory hint (device_status.capabilityHint).
// Reconciled with the scores-tier entitlement axis per correction C10: this is
// a DISTINCT, named predicate (package resolution ≠ scores tier), not a
// duplicate `isEntitled`.
// --------------------------------------------------------------------------

/** Injectable command runner — defaults to child_process.execFile. Returns the
 *  process exit code; never throws in the default impl (spawn errors → code 1). */
export type CommandRunner = (cmd: string, args: string[]) => Promise<{ code: number }>;

const defaultRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    // Lazy require so the browser/webview bundles never pull node:child_process.
    import("node:child_process")
      .then(({ execFile }) => {
        execFile(cmd, args, (error) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0 }));
      })
      .catch(() => resolve({ code: 1 }));
  });

/** True ⟺ the private Intonatissimo package resolves in `juliaProject` (the qilc
 *  strategy can run). Never throws — any failure (no julia, spawn error) → false. */
export async function isQilcEntitled(juliaProject: string, run: CommandRunner = defaultRunner): Promise<boolean> {
  const script = `using Pkg; exit(haskey(Pkg.project().dependencies, "Intonatissimo") ? 0 : 1)`;
  try {
    const { code } = await run("julia", [`--project=${juliaProject}`, "-e", script]);
    return code === 0;
  } catch {
    return false;
  }
}
