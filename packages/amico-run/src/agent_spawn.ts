// packages/amico-run/src/agent_spawn.ts — the tier-2 critic / planner subprocess mechanism
// (spec-20260728 §3.7). Shared: `spec review` spawns critics, `plan compile` spawns a planner.
//
// WHY A SUBPROCESS. `amico-run` has no provider SDK (its deps are @amicode/schema and smol-toml)
// and test/s31.test.ts fails CI on any ambient HTTP client in this layer outside a named EXEMPT
// set, whose comment records that lifting the ban "requires an explicit, reviewed S31 amendment."
// So a model call happens by spawning an already-authenticated agent CLI — the same shape as
// amico-pasqal spawning the connector. The S31 rule targets the HTTP surface only, so
// child_process is unaffected and no amendment is needed.
//
// (This comment deliberately does not spell out the banned identifiers: the guard is a grep over
// src/, and it caught an earlier draft of this very file for quoting them in prose. Keeping the
// guard dumb and rephrasing here is the right trade — a rule with an exception for comments is a
// rule with an exception.)
//
// WHY ASYNC `spawn` AND NOT `spawnSync`. §3.7 requires critics to run in PARALLEL under a
// whole-review ceiling. `spawnSync` blocks the thread: N critics would run strictly serially and
// an in-flight child could never be preempted by a ceiling — the two requirements cannot both
// hold. The repo's own precedent is async (pasqal_launch.ts, local_executor.ts).
//
// THE CREDENTIAL RULE. No secret is ever on argv (ps-visible, and it persists in shell history
// and transcripts). The child inherits the agent CLI's own credential store through an ALLOWLISTED
// env, built from scratch — never a `process.env` spread. The Pasqal launcher's discipline,
// different payload: it passes a secret IN, this passes none and inherits a store.
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { agentConfigContent } from "./agent_defs.js";
import type { Finding } from "./lenses.js";

export const DEFAULT_CRITIC_MODEL = "anthropic/claude-opus-5";
export const DEFAULT_CRITIC_VARIANT = "high";
/** Per-child ceiling (§3.7). A critic that has not answered in four minutes has failed.
 *  240s, not 120s: a frontier-class review of a full spec on a free-tier model takes
 *  ~3 minutes measured (178s for a 13k-token decomposition pass, 2026-07-31) — the
 *  two-minute ceiling read legitimate slow answers as failures and silently degraded
 *  every review to approved-mechanical/degraded. */
export const CRITIC_TIMEOUT_MS = 240_000;

/** Why a lens has no findings, which is NOT the same question as whether it ran.
 *
 *  `absent` (no binary / spawn error) means the mechanism was never available: every critic
 *  absent is `approved-mechanical`, an honest "never adversarially reviewed".
 *  `failed` (timeout, signal, empty or unparseable output) means the mechanism WAS available and
 *  this critic did not deliver: that is `degraded`.
 *
 *  Collapsing the two is a real defect the shipped runner had — it keyed the verdict on
 *  `critics.length === 0`, so three critics that all TIMED OUT against a working binary recorded
 *  "no critic binary available". Same field, two very different disclosures. */
export type SkipClass = "absent" | "failed";

export interface AgentOutcome {
  status: "ran" | "skipped";
  skip_class?: SkipClass;
  reason?: string;
  /** Read back from the CHILD's own output. Never argv — the ledger's independence disclosure
   *  must stamp a fact, not a request. A child that does not report one is `skipped`. */
  model?: string;
  variant?: string;
  findings: Finding[];
  /** §3.9: a finding that cannot say what would fix it is dropped. Counted so a silent drop
   *  cannot look like a clean critic. */
  dropped_no_remedy: number;
  /** For the planner, whose payload carries goal+steps rather than findings. */
  payload?: Record<string, unknown>;
}

/** Binary resolution: `$AMICO_CRITIC_BIN`, else `opencode` on PATH. Probed with X_OK at an
 *  ABSOLUTE path so the spawn is deterministic (pasqal_launch's discipline).
 *
 *  Returns `undefined` rather than throwing: an absent binary is the documented `--offline`
 *  degradation, not an error. A relative override is REJECTED — resolving it against cwd would
 *  make the spawn depend on where the user happened to be standing. */
export function resolveAgentBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.AMICO_CRITIC_BIN;
  if (override !== undefined && override.trim() !== "") {
    if (!isAbsolute(override)) return undefined;
    try {
      accessSync(override, fsConstants.X_OK);
      return override;
    } catch {
      return undefined;
    }
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "opencode");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** Env keys the child may see, and nothing else. Built FROM SCRATCH.
 *
 *  A `{...process.env}` spread would hand a reviewer every credential this process holds, for a
 *  job that needs one file and one model call. The allowlist is HOME/PATH (the CLI must run at
 *  all), XDG_* (config discovery), TMPDIR, and the agent CLI's own auth vars — the store it is
 *  already authenticated against. */
const ENV_ALLOWLIST = ["HOME", "PATH", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM"];
const ENV_ALLOW_PREFIXES = ["XDG_", "OPENCODE_"];
/** Live-session pointers: when amico runs INSIDE a live Amicode session, these
 *  ride the OPENCODE_ prefix allowance into the child, and the child's headless
 *  `run` tries to resolve the PARENT's session — failing with "Session not
 *  found" before the critic ever starts. The child spawns its own runtime; the
 *  parent's session pointers are never valid for it. Config vars
 *  (OPENCODE_CONFIG_CONTENT/DIR) stay — those are the legitimate prefix users. */
const ENV_DENYLIST = new Set(["OPENCODE", "OPENCODE_PID", "OPENCODE_SERVER_PASSWORD"]);

export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (ENV_DENYLIST.has(k)) continue;
    if (ENV_ALLOWLIST.includes(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, ...extra };
}

/** Recover the agent's payload from the event stream.
 *
 *  opencode `--format json` emits NDJSON — one `{type, timestamp, sessionID, ...data}` per line —
 *  NOT a findings array and NOT a single JSON document. The assistant's text arrives as
 *  `{type: "text", part: {text}}`, and the payload is in the LAST such event: earlier text parts
 *  are the model thinking out loud. Rev 2 of the spec had the child receiving a file path as its
 *  prompt and returning prose; this is the real shape.
 *
 *  Returns undefined on anything unparseable — never a partial parse. A half-read critic that
 *  reports "no findings" is worse than one that reports it could not be read. */
export function parseAgentOutput(stdout: string): Record<string, unknown> | undefined {
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // not every line is ours; a non-JSON line is not fatal to the stream
    }
    if (ev && typeof ev === "object") {
      const e = ev as { type?: unknown; part?: { text?: unknown } };
      if (e.type === "text" && typeof e.part?.text === "string") texts.push(e.part.text);
    }
  }
  // Search the text parts newest-first: earlier ones are the model thinking out loud.
  for (const candidate of texts.reverse()) {
    const obj = firstJsonObject(candidate);
    if (obj !== undefined) return obj;
  }
  // Fall back to raw stdout ONLY when the stream carried no text parts at all — i.e. the child
  // emitted a bare JSON answer instead of an event stream. Trying this fallback whenever the
  // text parts failed to parse is WRONG and was a real bug here: `firstJsonObject` would match
  // the event ENVELOPE (`{"type":"text","part":{…}}`), so a critic that returned prose, or
  // truncated JSON, came back as a successfully parsed payload with no findings — a silent clean
  // review out of an unreadable one, which is the exact failure §3.2 exists to prevent.
  return texts.length === 0 ? firstJsonObject(stdout) : undefined;
}

/** The first balanced `{…}` that parses. Agents wrap JSON in prose and fences no matter what the
 *  prompt says, so locating it is the parser's job rather than the model's. */
function firstJsonObject(s: string): Record<string, unknown> | undefined {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Coerce the payload's findings, dropping any without a remedy (§3.9). */
function readFindings(payload: Record<string, unknown>, lens: string, round: number): { findings: Finding[]; dropped: number } {
  const raw = Array.isArray(payload.findings) ? payload.findings : [];
  const findings: Finding[] = [];
  let dropped = 0;
  for (const f of raw) {
    if (!f || typeof f !== "object") {
      dropped++;
      continue;
    }
    const o = f as Record<string, unknown>;
    const remedy = typeof o.remedy === "string" ? o.remedy.trim() : "";
    if (remedy === "") {
      dropped++; // unactionable: dropped before it reaches the record
      continue;
    }
    findings.push({
      lens: typeof o.lens === "string" && o.lens !== "" ? o.lens : lens,
      severity: o.severity === "blocking" ? "blocking" : "advisory",
      claim: typeof o.claim === "string" ? o.claim : "",
      evidence: typeof o.evidence === "string" ? o.evidence : "",
      remedy,
      round,
    });
  }
  return { findings, dropped };
}

const skipped = (skip_class: SkipClass, reason: string): AgentOutcome => ({
  status: "skipped",
  skip_class,
  reason: reason.slice(0, 300),
  findings: [],
  dropped_no_remedy: 0,
});

export interface RunAgentOptions {
  bin: string;
  agent: "critic" | "planner";
  model?: string;
  variant?: string;
  /** The lens (critic) — used as the finding's default lens and named in the prompt. */
  lens?: string;
  prompt: string;
  /** The spec's TEXT, copied into the child's cwd. The child gets the spec and nothing else. */
  specText: string;
  specFilename?: string;
  timeoutMs?: number;
  round?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  spawn?: typeof nodeSpawn;
}

/** Spawn one agent and return what it produced.
 *
 *  NEVER THROWS. Every failure mode — no temp dir, spawn error, timeout, signal, empty stdout,
 *  unparseable stdout, a child that will not name its model — comes back as a `skipped` outcome
 *  with a reason. A dead critic must be a `skipped` lens, not a crashed review: the review is a
 *  gate on nothing (critics shape work, never block start), so failing it closed would be a
 *  denial of service on the whole loop. Same discipline as frontmatter.ts returning a result.
 *
 *  The temp dir is removed on EVERY path, including timeout and spawn error. */
export async function runAgent(opts: RunAgentOptions): Promise<AgentOutcome> {
  const spawnFn = opts.spawn ?? nodeSpawn;
  const model = opts.model ?? DEFAULT_CRITIC_MODEL;
  const variant = opts.variant ?? DEFAULT_CRITIC_VARIANT;
  const round = opts.round ?? 1;
  const lens = opts.lens ?? opts.agent;
  const timeoutMs = opts.timeoutMs ?? CRITIC_TIMEOUT_MS;

  let cwd: string | undefined;
  try {
    cwd = mkdtempSync(join(tmpdir(), "amico-agent-"));
    writeFileSync(join(cwd, opts.specFilename ?? "spec.md"), opts.specText);
  } catch (e) {
    // mkdtemp/writeFile can fail (read-only TMPDIR, quota). Still a result, never a throw.
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    return skipped("failed", `could not stage the child's working directory: ${(e as Error).message}`);
  }

  try {
    // Config travels in the ENV. `--config` does not exist on opencode and its CLI is .strict(),
    // so passing one would exit 1 with help text on stdout — read as "unparseable", skipping
    // every critic and making `approved-mechanical` the silent default on every review.
    const configDir = opts.env?.AMICO_AGENT_CONFIG_DIR ?? process.env.AMICO_AGENT_CONFIG_DIR;
    const extra: Record<string, string> = configDir
      ? { OPENCODE_CONFIG_DIR: configDir }
      : { OPENCODE_CONFIG_CONTENT: agentConfigContent() };

    const args = [
      "run",
      "--agent",
      opts.agent,
      "--model",
      model,
      "--variant",
      variant,
      "--format",
      "json",
      // The prompt is POSITIONAL after `--`. Rev 2's `--file <spec-copy>` was wrong: `--file`
      // ATTACHES a file, so the child would have received a path string as its prompt.
      "--",
      opts.prompt,
    ];

    const spawnOpts: SpawnOptions = {
      cwd,
      env: buildChildEnv(opts.env ?? process.env, extra),
      // stderr is captured for the reason field, stdin ignored — an agent that waits on input
      // would otherwise hang until the timeout with nothing to report.
      stdio: ["ignore", "pipe", "pipe"],
    };

    const res = await collect(spawnFn, opts.bin, args, spawnOpts, timeoutMs);
    if (res.kind === "spawn-error") return skipped("absent", res.reason);
    if (res.kind === "timeout") return skipped("failed", `no answer within ${timeoutMs}ms`);
    if (res.kind === "signal") return skipped("failed", `killed by ${res.signal}${tail(res.stderr)}`);
    if (res.stdout.trim() === "") return skipped("failed", `exit ${res.code} with empty stdout${tail(res.stderr)}`);

    const payload = parseAgentOutput(res.stdout);
    // A non-zero exit with PARSEABLE stdout still counts as having RUN (§3.7 row 2) — the child
    // answered and then failed to clean up, which is not the same as not answering.
    if (payload === undefined) return skipped("failed", `unparseable output (exit ${res.code})${tail(res.stderr)}`);

    const reportedModel = typeof payload.model === "string" ? payload.model : undefined;
    if (reportedModel === undefined || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(reportedModel)) {
      // Fail CLOSED. We could stamp `model` from argv and the row would validate — and it would
      // be a request masquerading as a fact, in the one field whose job is to let a reader judge
      // how independent the review was. Losing a critic is the cheaper error.
      return skipped("failed", "the child did not report the model it ran as");
    }
    const { findings, dropped } = readFindings(payload, lens, round);
    return {
      status: "ran",
      model: reportedModel,
      variant: typeof payload.variant === "string" && payload.variant !== "" ? payload.variant.slice(0, 32) : "default",
      findings,
      dropped_no_remedy: dropped,
      payload,
      reason: res.code === 0 ? undefined : `exit ${res.code} with usable output${tail(res.stderr)}`,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const tail = (stderr: string): string => {
  const s = stderr.trim();
  return s === "" ? "" : `: ${s.slice(-160)}`;
};

type Collected =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "signal"; signal: string; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "spawn-error"; reason: string };

/** Run the child to completion, a signal, or the timeout. Resolves — never rejects. */
function collect(
  spawnFn: typeof nodeSpawn,
  bin: string,
  args: string[],
  opts: SpawnOptions,
  timeoutMs: number,
): Promise<Collected> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnFn(bin, args, opts);
    } catch (e) {
      resolvePromise({ kind: "spawn-error", reason: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (c: Collected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(c);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); // SIGTERM can be swallowed; the ceiling must actually bite
      done({ kind: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    // ENOENT arrives as an `error` event, not a throw, when the binary is absent.
    child.on("error", (e) => done({ kind: "spawn-error", reason: e.message }));
    child.on("close", (code, signal) => {
      if (signal) done({ kind: "signal", signal, stdout, stderr });
      else done({ kind: "exit", code: code ?? 0, stdout, stderr });
    });
  });
}

/** Resolve the critic model (G-2: frontier, inheriting the session model). */
export function criticModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.AMICO_CRITIC_MODEL;
  return m !== undefined && m.trim() !== "" ? m.trim() : DEFAULT_CRITIC_MODEL;
}

export { resolve as resolvePathForTest };
