/** Turn-level traces (local-first observability).
 *
 *  One JSONL file per session under ~/.amico/amicode/traces/: every model call
 *  and tool call as a timed SPAN, OTel-compatible in shape so a future
 *  exporter is a mapping, not a rewrite. This is the record that answers
 *  "why was that turn slow" (prefill × round-trips × cache misses), "which
 *  turns silently errored" (the Gemini schema bug pattern), and "how do models
 *  compare on interview discipline" — locally, greppable, never leaving the
 *  machine (chats are research IP; scrub at record time like onboarding.ts).
 *
 *  CONTRACT (mirrored by the fork's GET /amicode/traces reader —
 *  harmoniqs/opencode packages/opencode/src/server/amicode/traces.ts; change
 *  both in one change-set):
 *    {v:1, ts, session, span:"model"|"tool"|"turn", id, name,
 *     dur_ms|null, attrs:{...}, error:string|null}
 *  Append-only; malformed lines are skipped by readers. */
import * as fs from "node:fs";
import * as path from "node:path";
import { opsDir, SECRET_RE } from "./onboarding";

export function tracesDir(ops: string = opsDir()): string {
  const env = process.env.AMICODE_TRACE_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(ops, "traces");
}

/** Kill switch: AMICODE_TRACES=0 disables recording entirely. */
export function tracesEnabled(): boolean {
  return process.env.AMICODE_TRACES !== "0";
}

const ATTR_MAX = 2000;

/** Bounded, secret-free stringification for attrs — a span is telemetry, not
 *  a transcript; big payloads get truncated with an explicit marker. */
export function scrubValue(v: unknown): unknown {
  if (typeof v === "string") {
    const cut = v.length > ATTR_MAX ? `${v.slice(0, ATTR_MAX)}…[truncated ${v.length}]` : v;
    return SECRET_RE.test(cut) ? "«credential omitted»" : cut;
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 32).map(scrubValue);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v).slice(0, 32)) out[k] = scrubValue(val);
    return out;
  }
  return undefined;
}

export interface Span {
  v: 1;
  ts: string;
  session: string;
  span: "model" | "tool" | "turn";
  id: string;
  name: string;
  dur_ms: number | null;
  attrs: Record<string, unknown>;
  error: string | null;
}

export function recordSpan(span: Span, dir: string = tracesDir()): void {
  if (!tracesEnabled()) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${span.session}.jsonl`), JSON.stringify(span) + "\n");
  } catch {
    /* telemetry must never break the session */
  }
}

/** Assistant message.updated → a "model" span, emitted ONCE per message when
 *  it completes (time.completed present). Carries the numbers that answer the
 *  perf questions: tokens incl. cache read/write, model, duration, error. */
export function spanFromMessageEvent(evt: unknown, seen: Set<string>): Span | undefined {
  const e = evt as { type?: string; properties?: { info?: Record<string, any> } };
  if (e?.type !== "message.updated") return undefined;
  const info = e.properties?.info;
  if (!info || info.role !== "assistant") return undefined;
  const completed = info.time?.completed;
  if (typeof completed !== "number" || typeof info.id !== "string" || seen.has(info.id)) return undefined;
  seen.add(info.id);
  const created = typeof info.time?.created === "number" ? info.time.created : null;
  const err = info.error ? JSON.stringify(scrubValue(info.error)).slice(0, 500) : null;
  return {
    v: 1,
    ts: new Date(completed).toISOString(),
    session: String(info.sessionID ?? "unknown"),
    span: "model",
    id: info.id,
    name: `${info.providerID ?? "?"}/${info.modelID ?? "?"}`,
    dur_ms: created !== null ? Math.max(0, completed - created) : null,
    attrs: {
      tokens: scrubValue(info.tokens) ?? {},
      cost: typeof info.cost === "number" ? info.cost : undefined,
      agent: typeof info.agent === "string" ? info.agent : undefined,
    },
    error: err,
  };
}

/** Hook bundle for the plugin: chat.message opens a turn span; the
 *  tool.execute before/after pair yields tool spans with real durations. */
export function makeTraceHooks(dir: string = tracesDir()) {
  const toolStarts = new Map<string, { tool: string; at: number }>();
  const seenMessages = new Set<string>();
  return {
    event: async ({ event }: { event: unknown }) => {
      const span = spanFromMessageEvent(event, seenMessages);
      if (span) recordSpan(span, dir);
    },
    "chat.message": async (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string },
      _output: unknown,
    ) => {
      recordSpan(
        {
          v: 1,
          ts: new Date().toISOString(),
          session: input.sessionID,
          span: "turn",
          id: input.messageID ?? `turn-${Date.now()}`,
          name: input.agent ?? "chat",
          dur_ms: null,
          attrs: { model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined },
          error: null,
        },
        dir,
      );
    },
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, _output: unknown) => {
      toolStarts.set(input.callID, { tool: input.tool, at: Date.now() });
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title?: string; output?: string },
    ) => {
      const start = toolStarts.get(input.callID);
      toolStarts.delete(input.callID);
      recordSpan(
        {
          v: 1,
          ts: new Date().toISOString(),
          session: input.sessionID,
          span: "tool",
          id: input.callID,
          name: input.tool,
          dur_ms: start ? Date.now() - start.at : null,
          attrs: {
            args: scrubValue(input.args) ?? {},
            title: typeof output?.title === "string" ? scrubValue(output.title) : undefined,
            output_chars: typeof output?.output === "string" ? output.output.length : undefined,
          },
          error: null,
        },
        dir,
      );
    },
  };
}
