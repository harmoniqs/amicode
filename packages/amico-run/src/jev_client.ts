// jev_client.ts — issue #1311 (slice of #1301 session curation): the ONE thin
// Jev client — TypeSafe AI's System One decision model — for amicode's
// confidence-gated curation middle layer.
//
// DOCTRINE (spec-20260920-jev-integration): deterministic rules are the front
// line; Jev is the middle layer on the residual only; every call is logged as
// ONE JSON decision record in the curation receipts journal (the S2 archiver's
// shared JSONL); fail-open everywhere — Jev down/slow/low-confidence degrades
// to today's behavior, never blocks a caller.
//
// WIRE CONTRACT (live-verified 2026-09-20 against the vendor API — the shape
// is the contract of record, superseding any earlier drafts):
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <key>   (Content-Type: application/json)
//   {"model":"jev-latest","state":<string|object>,"questions":{"<id>":<Question>}}
//   Question = {"type":"choice"|"noul","instructions":<string>,
//               "criteria":<choice: MAP option→rubric | noul: {"true":…,"false":…}>}
//   Response = {"model":"jev-1.13.0","answers":{"<id>":…},"usage":{"input_tokens":N,"output_tokens":N}}
//   choice answer = {"type":"choice","choice":"<option>","confidence":<float>,"probabilities":{…}}
//   noul answer   = {"type":"noul","noul":<float>}
// (~330–370 ms/call, ~500 input tokens — the microdollar band; state stays a
// deterministic fold, never a raw spine.)
//
// SECURITY POSTURE: the vendor key is server-side at ~/.amico/typesafe/key
// (mode 600), read at CALL time — never committed, never in a receipt, never
// in an error string. A missing/unreadable key = UNAVAILABLE: callers take
// the fail-open path. $AMICO_TYPESAFE_KEY_FILE overrides the path (tests).
//
// OFF-SWITCH: $AMICO_JEV_DISABLED truthy disables the entire Jev path with
// zero behavioral delta (the S2 ops-job env-flag convention).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The decision endpoint — live-verified; no OpenRouter listing for our key. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The model alias — the concrete version (e.g. jev-1.13.0) rides the response
 * and every receipt, so thresholds can be re-qualified on version changes. */
export const JEV_MODEL = "jev-latest";

/** One question over the confirmed shapes. `criteria` is a choice's
 * option→rubric MAP (a "no-match" option is one of OUR options) or a noul's
 * true/false description pair. */
export interface JevQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria: Record<string, string>;
}

/** A choice answer (typed verdict + calibrated confidence) or a noul
 * probability-of-yes. */
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: "noul"; noul: number };

export type JevUsage = { input_tokens: number; output_tokens: number };

/** The transport seam — injectable so the suite runs hermetically (no
 * network); the default is fetch with a bounded timeout (fail-open on slow). */
export type JevTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** A slow Jev is a failed Jev: the latency budget is per-session seams
 * (~350 ms expected); nothing waits on this client. */
export const JEV_TIMEOUT_MS = 10_000;

/** $AMICO_TYPESAFE_KEY_FILE → ~/.amico/typesafe/key (the secrets posture). */
export function jevKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_TYPESAFE_KEY_FILE;
  return v && v.trim() !== "" ? v : join(homedir(), ".amico", "typesafe", "key");
}

/** Truthy off-switch values; "0"/"false"/"no"/"off" keep the path enabled. */
export function jevDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AMICO_JEV_DISABLED ?? "").trim().toLowerCase();
  return v !== "" && !["0", "false", "no", "off"].includes(v);
}

/** The shared receipts journal (the S2 archiver's upgrade-receipts JSONL —
 * $AMICO_TYPESAFE_RECEIPTS → $AMICO_SERVER_DIR/upgrade-receipts/… → the default). */
export function jevReceiptsFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMICO_TYPESAFE_RECEIPTS;
  if (override && override.trim() !== "") return override;
  const server = env.AMICO_SERVER_DIR && env.AMICO_SERVER_DIR.trim() !== "" ? env.AMICO_SERVER_DIR : join(homedir(), ".amico", "server");
  return join(server, "upgrade-receipts", "upgrade-receipts.jsonl");
}

export interface JevDeps {
  env?: NodeJS.ProcessEnv;
  transport?: JevTransport;
  /** Receipts journal path; default jevReceiptsFile(env). */
  receiptsPath?: string;
  now?: () => number;
}

export type JevResult =
  | {
      ok: true;
      model: string;
      answers: Record<string, JevAnswer>;
      usage: JevUsage;
      latency_ms: number;
      /** Where the decision record landed (audit); undefined only if the
       * receipt write itself failed — the call still returns its answers. */
      receipt_path?: string;
    }
  | { ok: false; reason: "disabled" | "key-missing" | "http" | "malformed" | "transport"; error: string };

/** One Jev decision call: one or more questions over one state fold. NEVER
 * throws — every failure is {ok:false} and the caller's fail-open path.
 * Receipts: exactly ONE JSON decision-record line per attempted call (success
 * or failure) in the curation receipts journal; no call, no receipt. */
export async function askJev(
  questions: Record<string, JevQuestion>,
  state: unknown,
  opts: { sessionId?: string; deps?: JevDeps } = {},
): Promise<JevResult> {
  const deps = opts.deps ?? {};
  const env = deps.env ?? process.env;
  if (jevDisabled(env)) return { ok: false, reason: "disabled", error: "jev path disabled (AMICO_JEV_DISABLED)" };

  const keyPath = jevKeyFile(env);
  if (!existsSync(keyPath)) return { ok: false, reason: "key-missing", error: `jev key not found at ${keyPath} — the middle layer is unavailable; fail-open` };
  let key: string;
  try {
    key = readFileSync(keyPath, "utf8").trim();
  } catch {
    return { ok: false, reason: "key-missing", error: `jev key unreadable at ${keyPath} — the middle layer is unavailable; fail-open` };
  }
  if (key === "") return { ok: false, reason: "key-missing", error: `jev key empty at ${keyPath} — the middle layer is unavailable; fail-open` };

  const stateJson = JSON.stringify(state);
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  const started = (deps.now ?? Date.now)();

  const receiptOf = (result: JevResult): void => {
    // The decision record — one JSON line per call, the S2 receipts pattern.
    // A failed receipt write never fails the call (fail-open, both ways).
    const receipts = deps.receiptsPath ?? jevReceiptsFile(env);
    const answered = result.ok ? Object.values(result.answers) : [];
    const verdicts = Object.entries(result.ok ? result.answers : {}).map(([id, a]) => ({
      id,
      ...(a.type === "choice" ? { choice: a.choice, confidence: a.confidence } : { noul: a.noul }),
    }));
    const line = JSON.stringify({
      receipt_version: 1,
      ts: new Date(started).toISOString(),
      kind: "jev-decision",
      session_id: opts.sessionId,
      primitive: Object.values(questions).map((q) => q.type).join("+"),
      state_bytes: Buffer.byteLength(stateJson, "utf8"),
      ...(verdicts.length > 0 ? { verdicts } : {}),
      ...(answered.length > 0 && answered[0].type === "choice" ? { confidence: answered[0].confidence } : {}),
      latency_ms: (deps.now ?? Date.now)() - started,
      model: result.ok ? result.model : null,
      ...(result.ok ? { usage: result.usage } : {}),
      ...(!result.ok ? { error: result.error } : {}),
    });
    try {
      mkdirSync(dirname(receipts), { recursive: true });
      appendFileSync(receipts, `${line}\n`);
      if (result.ok) result.receipt_path = receipts;
    } catch {
      // the audit trail is best-effort; the decision still returns
    }
  };

  let res: { status: number; text(): Promise<string> };
  try {
    const transport = deps.transport ?? defaultTransport();
    res = await transport(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const result: JevResult = { ok: false, reason: "transport", error: error.slice(0, 160) };
    receiptOf(result);
    return result;
  }
  if (res.status !== 200) {
    const result: JevResult = { ok: false, reason: "http", error: `jev endpoint answered HTTP ${res.status}` };
    receiptOf(result);
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    const result: JevResult = { ok: false, reason: "malformed", error: "jev endpoint returned a malformed body" };
    receiptOf(result);
    return result;
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const answers = (typeof o.answers === "object" && o.answers !== null ? o.answers : {}) as Record<string, JevAnswer>;
  if (typeof o.model !== "string" || o.model === "" || Object.keys(answers).length === 0) {
    const result: JevResult = { ok: false, reason: "malformed", error: "jev endpoint returned no model or no answers" };
    receiptOf(result);
    return result;
  }
  const usage = (typeof o.usage === "object" && o.usage !== null ? o.usage : { input_tokens: 0, output_tokens: 0 }) as JevUsage;
  const result: JevResult = { ok: true, model: o.model, answers, usage, latency_ms: (deps.now ?? Date.now)() - started };
  receiptOf(result);
  return result;
}

/** The production transport: global fetch (Node 20+). */
function defaultTransport(): JevTransport {
  return (url, init) =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    }) as unknown as Promise<{ status: number; text(): Promise<string> }>;
}
