// ============================================================================
// QICK job-server (QUEUE) contract — Spec A §2.
//
// A minimal queue-layer contract any QICK job server can satisfy (Schuster's
// multimode `job_server` is impl #1). This is the QUEUE contract (submit /
// queue / history / status / cancel / config-versioning / health) consumed by
// the device view + calibration graph. It is DELIBERATELY distinct from:
//   - the 3-verb MEASUREMENT contract (upload_pulse!/trigger!/readout →
//     expt_service) the QILC inner loop speaks (Spec B), and
//   - Raghav's internal Amicode Scheduler/RunsManager (which queues pulse-design
//     *solves* off the runs/index).
// Do not conflate them (§2 reviewer flag).
//
// vscode-free + no Date.now/Math.random anywhere — so vitest runs the whole
// contract headless and deterministically (the run_registry.ts precedent).
// ============================================================================

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** Per-adapter OPAQUE experiment blob (§4.1). The `schuster` adapter reads the
 *  payload as a `job_server` job spec (class/module/config); the `mcp` adapter
 *  reads it as a named Snowbird MCP tool call. The queue verbs stay uniform;
 *  only the payload shape is adapter-specific. */
export interface ExperimentBlob {
  adapter: string;
  payload: unknown;
}

export interface SubmitRequest {
  user: string;
  experiment: ExperimentBlob;
  priority?: number;
  station_config?: unknown;
  config_version_ids?: Record<string, string>;
}

/** Job shape — adopted from Schuster verbatim (§2.2), not imposed. */
export interface Job {
  job_id: string;
  user: string;
  experiment: ExperimentBlob;
  status: JobStatus;
  priority: number;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  data_file_path?: string;
  error_message?: string;
  /** Canned/observed result payload (the node's produced params live here). */
  result?: Record<string, unknown>;
  config_version_ids?: Record<string, string>;
}

/** Live queue view — drives idle-detection (§5.1). */
export interface QueueView {
  running?: Job;
  pending: Job[];
}

/** An immutable calibration snapshot from the config-versioning ledger (§2.1). */
export interface ConfigVersion {
  version_id: string;
  type: string;
  payload?: unknown;
  created_at?: string;
  is_main?: boolean;
}

export interface HealthStats {
  pending: number;
  running: number;
}

export interface Health {
  ok: boolean;
  stats: HealthStats;
  /** Advisory entitlement hint (§5.2) — the RUN-TIME truth is package resolution. */
  capabilities?: string[];
  /** Drive-line channels the server reports online (§3.2 drive-lines-online). */
  channels?: string[];
}

export interface HistoryFilters {
  user?: string;
  status?: JobStatus;
  limit?: number;
}

/** Never-reject result envelope (§2.3): every adapter call returns this — a
 *  dead tunnel or a 500 degrades the view, never crashes the session. The
 *  in-memory MockJobServer returns DIRECT values (it cannot fail); the HTTP
 *  adapters (qick_client.ts) return `Result<T>`. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The adapter interface the HTTP clients implement (SchusterJobServer,
 *  SnowbirdMcpJobServer — qick_client.ts). Every verb is never-reject. */
export interface AbstractJobServer {
  submit(req: SubmitRequest): Promise<Result<{ job_id: string }>>;
  queue(): Promise<Result<QueueView>>;
  history(filters: HistoryFilters): Promise<Result<Job[]>>;
  status(jobId: string): Promise<Result<Job>>;
  cancel(jobId: string): Promise<Result<void>>;
  configVersions(type: string): Promise<Result<ConfigVersion[]>>;
  mainConfig(type: string): Promise<Result<ConfigVersion | undefined>>;
  pushConfig(type: string, payload: unknown): Promise<Result<ConfigVersion>>;
  setMain(type: string, versionId: string): Promise<Result<void>>;
  health(): Promise<Result<Health>>;
}

// --------------------------------------------------------------------------
// Never-throw parsers — the HTTP adapters route raw JSON through these so a
// malformed/partial payload degrades to an empty view instead of throwing.
// --------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const JOB_STATUSES: JobStatus[] = ["pending", "running", "completed", "failed", "cancelled"];

/** Parse one loosely-typed job object → Job, or undefined if it lacks a job_id.
 *  Never throws. */
export function parseJob(v: unknown): Job | undefined {
  const o = asRecord(v);
  if (!o) return undefined;
  const job_id = asString(o.job_id);
  if (!job_id) return undefined;
  const expRec = asRecord(o.experiment);
  const experiment: ExperimentBlob = {
    adapter: asString(expRec?.adapter) ?? asString(o.adapter) ?? "unknown",
    payload: expRec?.payload ?? o.expt_config ?? {},
  };
  const status = (JOB_STATUSES as string[]).includes(String(o.status)) ? (o.status as JobStatus) : "pending";
  return {
    job_id,
    user: asString(o.user) ?? "unknown",
    experiment,
    status,
    priority: asNumber(o.priority, 0),
    created_at: asString(o.created_at),
    started_at: asString(o.started_at),
    completed_at: asString(o.completed_at),
    data_file_path: asString(o.data_file_path),
    error_message: asString(o.error_message),
    result: asRecord(o.result),
    config_version_ids: asRecord(o.config_version_ids) as Record<string, string> | undefined,
  };
}

/** Parse a `GET /jobs/queue` body → {running, pending[]}. Never throws. */
export function parseQueue(v: unknown): QueueView {
  const o = asRecord(v);
  if (!o) return { running: undefined, pending: [] };
  const running = parseJob(o.running);
  const pendingRaw = Array.isArray(o.pending) ? o.pending : [];
  const pending = pendingRaw.map(parseJob).filter((j): j is Job => j !== undefined);
  return { running, pending };
}

/** Parse a `GET /jobs/history` body (array) → Job[]. Never throws. */
export function parseHistory(v: unknown): Job[] {
  const arr = Array.isArray(v) ? v : asRecord(v)?.jobs;
  if (!Array.isArray(arr)) return [];
  return arr.map(parseJob).filter((j): j is Job => j !== undefined);
}

/** Parse a config-versions body (array) → ConfigVersion[]. Never throws. */
export function parseConfigVersions(v: unknown): ConfigVersion[] {
  const arr = Array.isArray(v) ? v : asRecord(v)?.versions;
  if (!Array.isArray(arr)) return [];
  const out: ConfigVersion[] = [];
  for (const item of arr) {
    const o = asRecord(item);
    const version_id = asString(o?.version_id);
    if (!o || !version_id) continue;
    out.push({
      version_id,
      type: asString(o.type) ?? "",
      payload: o.payload,
      created_at: asString(o.created_at),
      is_main: o.is_main === true,
    });
  }
  return out;
}

/** Parse a single config-version object → ConfigVersion, or undefined. */
export function parseConfigVersion(v: unknown): ConfigVersion | undefined {
  const o = asRecord(v);
  const version_id = asString(o?.version_id);
  if (!o || !version_id) return undefined;
  return {
    version_id,
    type: asString(o.type) ?? "",
    payload: o.payload,
    created_at: asString(o.created_at),
    is_main: o.is_main === true,
  };
}

// --------------------------------------------------------------------------
// MockJobServer — in-memory queue + canned results + a settable capability set.
// All §6 acceptance tests run against it, no hardware. Deterministic: ids come
// from monotonic counters (NO Date.now / Math.random). Methods return DIRECT
// values (it cannot fail) — the never-reject Result<T> envelope is the HTTP
// adapters' concern (qick_client.ts).
// --------------------------------------------------------------------------

export interface MockJobServerOptions {
  capabilities?: string[];
  channels?: string[];
}

interface PendingEntry {
  job: Job;
  seq: number;
}

export class MockJobServer {
  private jobCounter = 0;
  private cfgCounter = 0;
  private seqCounter = 0;
  private pendingEntries: PendingEntry[] = [];
  private runningJob?: Job;
  private readonly done: Job[] = [];
  private readonly configs = new Map<string, ConfigVersion[]>();
  private readonly mains = new Map<string, string>();
  private readonly capabilities?: string[];
  private readonly channels?: string[];

  constructor(opts: MockJobServerOptions = {}) {
    this.capabilities = opts.capabilities;
    this.channels = opts.channels;
  }

  /** Pending sorted the way it would run: priority desc, then FIFO (seq asc). */
  private sortedPending(): PendingEntry[] {
    return [...this.pendingEntries].sort((a, b) => b.job.priority - a.job.priority || a.seq - b.seq);
  }

  async submit(req: SubmitRequest): Promise<Job> {
    const job: Job = {
      job_id: `JOB-${++this.jobCounter}`,
      user: req.user,
      experiment: req.experiment,
      status: "pending",
      priority: req.priority ?? 0,
      config_version_ids: req.config_version_ids,
    };
    this.pendingEntries.push({ job, seq: ++this.seqCounter });
    return { ...job };
  }

  async queue(): Promise<QueueView> {
    return {
      running: this.runningJob ? { ...this.runningJob } : undefined,
      pending: this.sortedPending().map((e) => ({ ...e.job })),
    };
  }

  async history(filters: HistoryFilters): Promise<Job[]> {
    let jobs = this.done;
    if (filters.user !== undefined) jobs = jobs.filter((j) => j.user === filters.user);
    if (filters.status !== undefined) jobs = jobs.filter((j) => j.status === filters.status);
    const out = jobs.map((j) => ({ ...j }));
    return filters.limit !== undefined ? out.slice(-filters.limit) : out;
  }

  async status(jobId: string): Promise<Job | undefined> {
    if (this.runningJob?.job_id === jobId) return { ...this.runningJob };
    const pend = this.pendingEntries.find((e) => e.job.job_id === jobId);
    if (pend) return { ...pend.job };
    const fin = this.done.find((j) => j.job_id === jobId);
    return fin ? { ...fin } : undefined;
  }

  async cancel(jobId: string): Promise<boolean> {
    const idx = this.pendingEntries.findIndex((e) => e.job.job_id === jobId);
    if (idx === -1) return false;
    const [entry] = this.pendingEntries.splice(idx, 1);
    this.done.push({ ...entry.job, status: "cancelled" });
    return true;
  }

  /** TEST HELPER (not a contract verb): promote the highest-priority pending job
   *  to running, then finish it with the given outcome (default: completed with
   *  the supplied result). Returns the finished job, or undefined if idle. */
  async runNext(outcome: { result?: Record<string, unknown>; status?: JobStatus; error?: string } = {}): Promise<Job | undefined> {
    const ordered = this.sortedPending();
    if (ordered.length === 0) return undefined;
    const head = ordered[0];
    this.pendingEntries = this.pendingEntries.filter((e) => e !== head);
    const status: JobStatus = outcome.status ?? (outcome.error ? "failed" : "completed");
    const finished: Job = {
      ...head.job,
      status,
      result: outcome.result,
      error_message: outcome.error,
    };
    this.runningJob = undefined;
    this.done.push(finished);
    return { ...finished };
  }

  async configVersions(type: string): Promise<ConfigVersion[]> {
    return (this.configs.get(type) ?? []).map((v) => ({ ...v, is_main: this.mains.get(type) === v.version_id }));
  }

  async mainConfig(type: string): Promise<ConfigVersion | undefined> {
    const mainId = this.mains.get(type);
    if (!mainId) return undefined;
    const found = (this.configs.get(type) ?? []).find((v) => v.version_id === mainId);
    return found ? { ...found, is_main: true } : undefined;
  }

  async pushConfig(type: string, payload: unknown): Promise<ConfigVersion> {
    const ver: ConfigVersion = { version_id: `CFG-${type}-${++this.cfgCounter}`, type, payload };
    const list = this.configs.get(type) ?? [];
    list.push(ver);
    this.configs.set(type, list);
    return { ...ver };
  }

  async setMain(type: string, versionId: string): Promise<void> {
    this.mains.set(type, versionId);
  }

  async health(): Promise<Health> {
    return {
      ok: true,
      stats: { pending: this.pendingEntries.length, running: this.runningJob ? 1 : 0 },
      capabilities: this.capabilities,
      channels: this.channels,
    };
  }
}
