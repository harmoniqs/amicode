// sota_staging.ts — the per-campaign SIDECAR staging streams (#living-sota
// slice 2, spec spec-20260905-103000 D3 / S3): append-only transition streams
// BESIDE the session ledger — `<ledger-stem>.sota-staging.jsonl` under the
// personal vault's sessions/ dir (the nine-section ledger grammar holds
// UNAMENDED; the sidecar is a SEPARATE file, one writer class, no collision
// with the live campaign session's own ledger writes). The hopper fallback is
// the same machinery under the reserved stem `hopper` — the flywheel's drain
// extends to it (the coordination note's feed).
//
// ── The transition grammar (all appended lines; entries never mutated;
//    staging state always DERIVED by replay) ────────────────────────────────
//
//   stage  {ev, seq, ts, event_id, campaign, kind, title, url, provenance,
//          matched?, reason?, review_by, expires_at}
//   accept {ev, seq, ts, event_id, campaign, kind, title, url,
//          instructed_by: "PI", instruction: {channel, note, received_at}}
//   drop   {ev, seq, ts, event_id, campaign, reason, recorded}
//   compact{ev, seq, ts, removed, window_days, high_water_seq, compacted_at}
//
// Event ids are the EXTERNAL identity (arxiv:<id> for papers, github:<id> for
// watcher events) — idempotency keys, so double-delivery is impossible: the
// appender dedupes centrally by event id (ONE APPENDER — the digest, the
// watcher, and the weekly synthesis are the ONLY stage/drop writers; the
// read-then-append here is safe ONLY because that writer class is single,
// which is exactly what the one-appender invariant buys).
//
// The accept stamp is the SOLE sanctioned non-job append: an agent writing on
// the PI's EXPLICIT instruction records the decision — `instructed_by: "PI"`
// + the instruction provenance (channel, note, received_at). Its schema rides
// the bridge fixtures (obligation O3: fixtures/bridge/2026-09-05-sota-staging,
// validated by scripts/validate_bridge_replay.mjs).
//
// ── Line-atomicity (the coordination-ledger discipline) ────────────────────
//
// Every line is one JSON object ≤ PIPE_BUF (4096 B) written with O_APPEND:
// a concurrent reader never sees a torn line, and `kill -9` loses at most the
// line in flight. A LIVE reader (deriveStagingState) skips an incomplete
// trailing line and keeps the rest; a torn line MID-stream is corruption the
// writers refuse to create (throw, never a torn append).
//
// ── The stamps ─────────────────────────────────────────────────────────────
//
// REVIEW_BY_DAYS = 7: one full weekly-brief cycle — the awaiting-the-eye
//   listing the PI reads weekly names the review-by date.
// EXPIRES_AFTER_DAYS = 14: a SECOND full weekly cycle of grace, then the
//   job-appended drop with the recorded reason (expired-without-review) —
//   missing one weekly is human, missing two is the chronic-non-review signal
//   the health stamp exists to render ("reads sick, not clean").
// COMPACTION_WINDOW_DAYS = 28 (O2, the pinned number): expired-and-dropped
//   chains compact once their drop is 28 days old. Why 28: the trailing
//   expired-without-review health stamp needs a month of history to show a
//   month of neglect — four weekly digests, the human triage horizon — and
//   beyond that the quiet-failure noise is archival, not actionable (the
//   bounded-window discipline of sota_history: keep what the trailing window
//   reads, nothing more). The compaction REWRITES the stream atomically and
//   RECORDS itself as an appended compact line (removed, window, the
//   pre-compaction high-water seq) — never a silent mutation. Accepted and
//   pending entries are NEVER compacted: derivation reads accepted-only, so
//   the accepted record stands forever.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIPE_BUF } from "./ledger.js";

export const SIDECAR_SUFFIX = ".sota-staging.jsonl";

/** The reserved stem for the fallback stream — the hopper feed (the flywheel's
 *  drain expectations extend to it, per the coordination note). */
export const HOPPER_CAMPAIGN = "hopper";

/** The review-by stamp: one full weekly-brief cycle. */
export const REVIEW_BY_DAYS = 7;

/** The expiry stamp: a second full weekly cycle of grace, then the recorded drop. */
export const EXPIRES_AFTER_DAYS = 14;

/** O2: the compaction window — expired-and-dropped chains compact at 28 days
 *  (four weekly digests; the trailing health window stays computable). */
export const COMPACTION_WINDOW_DAYS = 28;

/** The named drop reason for a staged match past its expiry without review. */
export const EXPIRED_WITHOUT_REVIEW = "expired-without-review";

// ── types ───────────────────────────────────────────────────────────────────

export type StagingKind = "paper" | "release" | "changelog" | "issue";

/** The provenance stamp every stage line carries (where the match CAME from —
 *  a cache read never launders as a live fetch). */
export interface StagingProvenance {
  job: string; // papers-digest | sota-watcher | …
  via: string; // cache | fetched | feed
  source: string; // the fetch surface, named
  fetched_at: string; // ISO-8601
  [key: string]: unknown; // job-specific stamps (repo, surface, query, …)
}

/** The PI-instruction provenance the accept stamp records (the schema is the
 *  human decision's record — an accept without it is refused). */
export interface AcceptInstruction {
  channel: string; // chat | review | issue — where the instruction arrived
  note: string; // the PI's instruction, verbatim or near-verbatim
  received_at?: string; // ISO-8601; defaults to the stamp's ts
}

export interface StageEntryInput {
  event_id: string;
  campaign: string;
  kind: StagingKind;
  title: string;
  url: string;
  provenance: StagingProvenance;
  /** The matched campaign terms (explainable: the line says WHY it staged here). */
  matched?: string[];
  /** For hopper entries: the named reason (below-threshold | no-campaign-match). */
  reason?: string;
}

interface StageLine {
  ev: "stage";
  seq: number;
  ts: string;
  event_id: string;
  campaign: string;
  kind: StagingKind;
  title: string;
  url: string;
  provenance: StagingProvenance;
  matched?: string[];
  reason?: string;
  review_by: string;
  expires_at: string;
}
interface AcceptLine {
  ev: "accept";
  seq: number;
  ts: string;
  event_id: string;
  campaign: string;
  kind?: string;
  title?: string;
  url?: string;
  instructed_by: "PI";
  instruction: { channel: string; note: string; received_at: string };
}
interface DropLine {
  ev: "drop";
  seq: number;
  ts: string;
  event_id: string;
  campaign: string;
  reason: string;
  recorded: string;
}
interface CompactLine {
  ev: "compact";
  seq: number;
  ts: string;
  removed: number;
  window_days: number;
  high_water_seq: number;
  compacted_at: string;
}
/** Unknown-but-well-formed ev values are CARRIED (reader opacity — the bridge
 *  doctrine's forward-compat rule); `record` is the raw line. */
export type StagingLine = (StageLine | AcceptLine | DropLine | CompactLine | { ev: string; seq: number; ts: string; [k: string]: unknown }) & {
  seq: number;
  ts: string;
};

export interface StagedEntryState {
  event_id: string;
  campaign: string;
  kind?: string;
  title?: string;
  url?: string;
  provenance?: StagingProvenance;
  matched?: string[];
  reason?: string;
  review_by?: string;
  expires_at?: string;
  state: "staged" | "accepted" | "dropped";
  /** Set when an accept/drop line has no stage line behind it — carried by the
   *  reader (never fatal); the WRITERS refuse to create it, the validator reds it. */
  orphan?: boolean;
  accepted_at?: string;
  instruction?: { channel: string; note: string; received_at: string };
  drop_reason?: string;
  dropped_at?: string;
}

export interface StagingState {
  lines: StagingLine[];
  entries: Map<string, StagedEntryState>;
}

export interface StagingOpts {
  nowMs?: () => number;
}

export type AppendResult =
  | { appended: true }
  | { appended: false; reason: string };

// ── paths ───────────────────────────────────────────────────────────────────

/** The sidecar stream path for one campaign stem (a session-ledger file stem,
 *  or `hopper`), beside the ledger under sessions/. */
export function stagingStreamPath(sessionsDir: string, campaign: string): string {
  return join(sessionsDir, campaign + SIDECAR_SUFFIX);
}

/** Every campaign stem with a sidecar stream under sessions/ (the sweep and
 *  the awaiting-the-eye render enumerate these; stems are file names minus
 *  the suffix — no directory reaches out of sessions/). */
export function listStagingStreams(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  try {
    return readdirSync(sessionsDir)
      .filter((n) => n.endsWith(SIDECAR_SUFFIX))
      .map((n) => n.slice(0, -SIDECAR_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

// ── the low-level append (ONE writer discipline: callers are the jobs, or
//    the accept stamp on the PI's instruction) ───────────────────────────────

function writeLine(path: string, line: StagingLine): void {
  const text = JSON.stringify(line) + "\n";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PIPE_BUF) {
    throw new Error(
      `staging line exceeds PIPE_BUF: ${bytes} B > ${PIPE_BUF} B — O_APPEND atomicity holds only under the ceiling; truncate the payload, never the discipline`,
    );
  }
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, text, { flag: "a" }); // O_APPEND: atomic per line
}

// ── reading + derivation (readers tolerate; writers are strict) ─────────────

export interface ReadStagingResult {
  lines: StagingLine[];
  /** The stream ends on a whole line (false = a torn in-flight tail was skipped). */
  tornTail: boolean;
}

/** Read a stream as raw lines. A torn FINAL line (live in-flight write) is
 *  skipped; a torn line ELSEWHERE is corruption — the writers' atomic
 *  appends never create it, so the reader throws (the validator reds it). */
export function readStagingStream(path: string): ReadStagingResult {
  if (!existsSync(path)) return { lines: [], tornTail: false };
  const text = readFileSync(path, "utf8");
  if (text === "") return { lines: [], tornTail: false };
  const parts = text.split("\n");
  // a trailing "" is the final newline; a non-"" tail is a torn in-flight line
  let tornTail = false;
  let rawLines: string[];
  if (parts[parts.length - 1] === "") rawLines = parts.slice(0, -1);
  else {
    rawLines = parts.slice(0, -1);
    tornTail = true; // the incomplete final chunk is skipped by a LIVE reader
  }
  const lines: StagingLine[] = [];
  rawLines.forEach((l, i) => {
    if (l.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new Error(
        `staging stream corruption: ${path} line ${i + 1} is not a whole JSON object — the writers append atomically under PIPE_BUF, so a torn MID-stream line was never a live write`,
      );
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`staging stream corruption: ${path} line ${i + 1} is not a JSON object`);
    }
    lines.push(v as StagingLine);
  });
  return { lines, tornTail };
}

/** Derive staging state by replay — the ONLY way state exists. Per event_id:
 *  the first line must be a stage (accept/drop behind none is carried as
 *  `orphan`, never fatal to the reader); accept and drop are terminal; unknown
 *  ev values are carried through untouched (opacity). */
export function deriveStagingState(path: string): StagingState {
  const { lines } = readStagingStream(path);
  const entries = new Map<string, StagedEntryState>();
  for (const line of lines) {
    const rec = line as Record<string, unknown>;
    const ev = typeof rec.ev === "string" ? rec.ev : "";
    if (ev !== "stage" && ev !== "accept" && ev !== "drop") continue; // carried (compact/unknown), no state change
    const id = typeof rec.event_id === "string" ? rec.event_id : "";
    if (id === "") continue;
    const existing = entries.get(id);
    if (ev === "stage") {
      if (existing === undefined) {
        entries.set(id, {
          event_id: id,
          campaign: typeof rec.campaign === "string" ? rec.campaign : "",
          kind: typeof rec.kind === "string" ? rec.kind : undefined,
          title: typeof rec.title === "string" ? rec.title : undefined,
          url: typeof rec.url === "string" ? rec.url : undefined,
          provenance: (rec.provenance as StagingProvenance | undefined) ?? undefined,
          matched: Array.isArray(rec.matched) ? (rec.matched as string[]) : undefined,
          reason: typeof rec.reason === "string" ? rec.reason : undefined,
          review_by: typeof rec.review_by === "string" ? rec.review_by : undefined,
          expires_at: typeof rec.expires_at === "string" ? rec.expires_at : undefined,
          state: "staged",
        });
      }
      continue; // a duplicate stage is deduped at write time; a reader carries it inertly
    }
    if (existing === undefined) {
      entries.set(id, {
        event_id: id,
        campaign: typeof rec.campaign === "string" ? rec.campaign : "",
        state: ev === "accept" ? "accepted" : "dropped",
        orphan: true, // carried, never fatal — the writers refuse to create it
        ...(ev === "accept"
          ? { accepted_at: typeof rec.ts === "string" ? rec.ts : undefined }
          : { drop_reason: typeof rec.reason === "string" ? rec.reason : undefined, dropped_at: typeof rec.recorded === "string" ? rec.recorded : undefined }),
      });
      continue;
    }
    if (existing.state !== "staged") continue; // terminal stays terminal (idempotent replay)
    if (ev === "accept") {
      existing.state = "accepted";
      existing.accepted_at = typeof rec.ts === "string" ? rec.ts : undefined;
      if (rec.instruction && typeof rec.instruction === "object") {
        existing.instruction = rec.instruction as { channel: string; note: string; received_at: string };
      }
    } else {
      existing.state = "dropped";
      existing.drop_reason = typeof rec.reason === "string" ? rec.reason : undefined;
      existing.dropped_at = typeof rec.recorded === "string" ? rec.recorded : undefined;
    }
  }
  return { lines, entries };
}

// ── the writers (STRICT: they validate their own input; readers tolerate) ────

function assertStageInput(entry: StageEntryInput): void {
  if (entry.event_id.trim() === "") throw new Error("stage line: event_id is required (the idempotency key)");
  if (entry.campaign.trim() === "") throw new Error("stage line: campaign is required");
  if (!/^(paper|release|changelog|issue)$/.test(entry.kind)) throw new Error(`stage line: unknown kind "${entry.kind}"`);
  if (typeof entry.url !== "string" || entry.url === "") throw new Error("stage line: url is required (every match is cited)");
  const p = entry.provenance;
  if (typeof p.job !== "string" || p.job === "" || typeof p.via !== "string" || p.via === "" || typeof p.source !== "string" || p.source === "" || typeof p.fetched_at !== "string" || p.fetched_at === "") {
    throw new Error("stage line: provenance must carry {job, via, source, fetched_at} — a match never lands unprovenance-stamped");
  }
}

/** Append a `stage` transition — the digest's and the watcher's writer
 *  (ONE APPENDER). Idempotent by event id: a delivery whose event is already
 *  in the stream (staged, accepted, or dropped) is a no-op with the named
 *  reason — double-delivery is impossible. */
export function appendStageLine(path: string, entry: StageEntryInput, opts: StagingOpts = {}): AppendResult {
  assertStageInput(entry);
  const nowMs = opts.nowMs ?? Date.now;
  const { lines } = readStagingStream(path);
  if (lines.some((l) => (l as { event_id?: unknown }).event_id === entry.event_id)) {
    return { appended: false, reason: `duplicate-delivery: ${entry.event_id} is already in the stream (deduped centrally by event id)` };
  }
  const ts = new Date(nowMs()).toISOString();
  const line: StageLine = {
    ev: "stage",
    seq: lines.length + 1, // seq IS the line count at write time
    ts,
    event_id: entry.event_id,
    campaign: entry.campaign,
    kind: entry.kind,
    title: entry.title.slice(0, 240),
    url: entry.url,
    provenance: entry.provenance,
    ...(entry.matched !== undefined ? { matched: entry.matched } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    review_by: new Date(nowMs() + REVIEW_BY_DAYS * 86_400_000).toISOString(),
    expires_at: new Date(nowMs() + EXPIRES_AFTER_DAYS * 86_400_000).toISOString(),
  };
  writeLine(path, line);
  return { appended: true };
}

/** The PI-instructed acceptance stamp — the SOLE sanctioned non-job append: an
 *  agent acting on the PI's EXPLICIT instruction records the human decision.
 *  Idempotent by (event, accept); refused without a staged match, refused on
 *  a dropped match (terminal), refused without the instruction provenance. */
export function appendAcceptStamp(path: string, event_id: string, instruction: AcceptInstruction, opts: StagingOpts = {}): AppendResult {
  const nowMs = opts.nowMs ?? Date.now;
  if (typeof instruction.note !== "string" || instruction.note.trim() === "") {
    return { appended: false, reason: "refused: the acceptance stamp records the PI's explicit instruction — the instruction note is required (an unstamped acceptance is a laundered one)" };
  }
  const { lines, entries } = deriveStagingState(path);
  const entry = entries.get(event_id);
  if (entry === undefined || entry.orphan === true) {
    return { appended: false, reason: `refused: no staged match for ${event_id} — the stamp is the record of a human decision ON a staged match, never free-floating` };
  }
  if (entry.state === "accepted") {
    return { appended: false, reason: `already-accepted: ${event_id} (idempotent — the stamp records once)` };
  }
  if (entry.state === "dropped") {
    return { appended: false, reason: `refused: ${event_id} was dropped (${entry.drop_reason ?? "unknown reason"}) — a drop is terminal; re-stage the match if the PI wants it` };
  }
  const ts = new Date(nowMs()).toISOString();
  const line: AcceptLine = {
    ev: "accept",
    seq: lines.length + 1,
    ts,
    event_id,
    campaign: entry.campaign,
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    instructed_by: "PI",
    instruction: {
      channel: instruction.channel,
      note: instruction.note.slice(0, 240),
      received_at: instruction.received_at ?? ts,
    },
  };
  writeLine(path, line);
  return { appended: true };
}

/** Append a `drop` transition — the expiry writer inside the digest/synthesis
 *  job (ONE APPENDER). Refused on an accepted match (acceptance is terminal)
 *  and without a stage; idempotent on an already-dropped match. */
export function appendDropLine(path: string, event_id: string, reason: string, opts: StagingOpts = {}): AppendResult {
  const nowMs = opts.nowMs ?? Date.now;
  const { lines, entries } = deriveStagingState(path);
  const entry = entries.get(event_id);
  if (entry === undefined || entry.orphan === true) {
    return { appended: false, reason: `refused: no staged match for ${event_id} — a drop line records the fate of a staged match` };
  }
  if (entry.state === "accepted") {
    return { appended: false, reason: `refused: ${event_id} is ACCEPTED — acceptance is terminal, an accepted match never drops` };
  }
  if (entry.state === "dropped") {
    return { appended: false, reason: `already-dropped: ${event_id} (idempotent)` };
  }
  const ts = new Date(nowMs()).toISOString();
  const line: DropLine = {
    ev: "drop",
    seq: lines.length + 1,
    ts,
    event_id,
    campaign: entry.campaign,
    reason,
    recorded: ts, // the recorded line
  };
  writeLine(path, line);
  return { appended: true };
}

/** The expiry sweep (the weekly job's drop writer): every staged match past
 *  its `expires_at` gets a job-appended drop line with the recorded reason.
 *  A pipeline that stages and drops without ever being reviewed reads SICK
 *  via the expired-without-review count, not clean. */
export function sweepExpiry(path: string, opts: StagingOpts = {}): { dropped: string[] } {
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const { entries } = deriveStagingState(path);
  const dropped: string[] = [];
  for (const entry of entries.values()) {
    if (entry.state !== "staged" || entry.expires_at === undefined) continue;
    if (Date.parse(entry.expires_at) > now) continue; // not yet expired — stage-before-count holds
    const r = appendDropLine(path, entry.event_id, EXPIRED_WITHOUT_REVIEW, opts);
    if (r.appended) dropped.push(entry.event_id);
  }
  dropped.sort(); // deterministic across map order
  return { dropped };
}

/** O2 — the compaction pass: expired-and-dropped chains whose drop is older
 *  than the 28-day window are removed (the whole chain: stage + drop), the
 *  rewrite is ATOMIC (tmp+rename), and the stream RECORDS its own compaction
 *  as an appended compact line — never a silent mutation. Accepted and
 *  pending entries are never removed; seq is renumbered so seq = line count
 *  holds for the rewritten stream (the compact line carries the
 *  pre-compaction high-water seq — nothing is lost). */
export function compactStagingStream(path: string, opts: StagingOpts = {}): { removed: number } {
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const { lines, entries } = deriveStagingState(path);
  const eligible = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.state !== "dropped" || entry.drop_reason !== EXPIRED_WITHOUT_REVIEW || entry.dropped_at === undefined) continue;
    if (now - Date.parse(entry.dropped_at) <= COMPACTION_WINDOW_DAYS * 86_400_000) continue;
    eligible.add(entry.event_id);
  }
  if (eligible.size === 0) return { removed: 0 }; // idle compaction is not an event — no noise lines
  const kept = lines.filter((l) => {
    const rec = l as { ev?: unknown; event_id?: unknown };
    if (typeof rec.event_id === "string" && eligible.has(rec.event_id)) return false; // the whole chain goes
    return true;
  });
  const highWater = lines.length;
  const ts = new Date(now).toISOString();
  const compactLine: CompactLine = {
    ev: "compact",
    seq: kept.length + 1,
    ts,
    removed: highWater - kept.length, // LINES removed (each chain is its stage+transition lines)
    window_days: COMPACTION_WINDOW_DAYS,
    high_water_seq: highWater,
    compacted_at: ts,
  };
  const out = [...kept, compactLine].map((l, i) => ({ ...(l as Record<string, unknown>), seq: i + 1 }));
  const text = out.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path); // atomic: a reader sees the whole stream or the old one
  return { removed: highWater - kept.length };
}

// ── the awaiting-the-eye render (derived state ONLY; never currency) ────────

/** The trailing-window EXPIRED-WITHOUT-REVIEW count — the brief's health
 *  stamp input (a pipeline that stages and drops without review reads sick). */
export function expiredWithoutReviewCount(path: string, opts: StagingOpts = {}): number {
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const { entries } = deriveStagingState(path);
  let n = 0;
  for (const e of entries.values()) {
    if (e.state !== "dropped" || e.drop_reason !== EXPIRED_WITHOUT_REVIEW || e.dropped_at === undefined) continue;
    if (now - Date.parse(e.dropped_at) <= COMPACTION_WINDOW_DAYS * 86_400_000) n++;
  }
  return n;
}

/** The awaiting-the-eye listing: everything PENDING (staged, un-reviewed,
 *  provenance-stamped) + the expired-without-review counts — rendered from
 *  DERIVED state. Accepted material is currency and appears NOWHERE here; a
 *  false-positive match can never launder into strategy — the human eye sits
 *  between the match and the composition. */
export function renderAwaitingTheEye(paths: string[], opts: StagingOpts = {}): string {
  const nowMs = opts.nowMs ?? Date.now;
  const now = nowMs();
  const groups: { stem: string; pending: StagedEntryState[]; expired: number }[] = [];
  let pendingTotal = 0;
  let expiredTotal = 0;
  for (const p of paths) {
    const stem = p.split("/").pop()?.replace(/\.sota-staging\.jsonl$/, "") ?? "(stream)";
    const { entries } = deriveStagingState(p);
    const pending = [...entries.values()].filter((e) => e.state === "staged").sort((a, b) => a.event_id.localeCompare(b.event_id));
    const expired = expiredWithoutReviewCount(p, { nowMs: () => now });
    if (pending.length === 0 && expired === 0) continue;
    groups.push({ stem, pending, expired });
    pendingTotal += pending.length;
    expiredTotal += expired;
  }
  const lines: string[] = [
    "## Awaiting the eye — staged matches pending review (never rendered as currency)",
    `pending staged matches: ${pendingTotal} · expired-without-review (trailing ${COMPACTION_WINDOW_DAYS} days): ${expiredTotal}`,
    "",
  ];
  if (groups.length === 0) {
    lines.push("_nothing pending — the staged streams are empty._");
    return lines.join("\n");
  }
  for (const g of groups) {
    lines.push(`### ${g.stem} (${g.pending.length} pending${g.expired > 0 ? `, ${g.expired} expired without review` : ""})`);
    for (const e of g.pending) {
      lines.push(`- **${e.title ?? "(untitled)"}** (${e.event_id})${e.url ? ` — ${e.url}` : ""}`);
      const prov = e.provenance;
      const provText = prov ? `${prov.job} via ${prov.via} (${prov.source})` : "provenance absent";
      const matched = e.matched && e.matched.length > 0 ? ` · matched: ${e.matched.join(", ")}` : "";
      const reason = e.reason ? ` · ${e.reason}` : "";
      const reviewBy = e.review_by ? ` · review by ${e.review_by.slice(0, 10)}` : "";
      lines.push(`  _staged ${e.expires_at ? `expires ${e.expires_at.slice(0, 10)}` : ""}${reviewBy} · provenance: ${provText}${matched}${reason}_`);
    }
    lines.push("");
  }
  lines.push("_derivation reads accepted-only: nothing above counts until the PI's accept stamp lands._");
  return lines.join("\n");
}
