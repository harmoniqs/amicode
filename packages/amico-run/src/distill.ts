// distill.ts — the pure core behind `amico distill` (amicode #1680, brain
// flywheel slice 1 — the artery): the candidate claim-note renderer, the
// state-stamp read/write, and the evidence-pointer vocabulary.
//
// DOCTRINE (issue #1679, the company-brain flywheel): the chat DB is the ONE
// substrate — this module and everything it renders are projections with
// provenance pointers back. Every pointer a note carries must RESOLVE into
// the substrate (the constraint, mechanically: pointers are built from the
// DB rows the verb just read, and the suite resolves them back). Machinery
// never edits existing prose: the renderer only CREATES `claim-<session>.md`
// notes in the dedicated candidate area; the dedupe/lifecycle passes (later
// slices) own everything downstream of a candidate.
//
// PURITY: no DB, no I/O at render time except the stamp file helpers (which
// take explicit paths and never throw), no clock (dates passed in). The
// renderer is deterministic: same rows + same verdict → same bytes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAIM_TYPE_NONE } from "./jev_curation.js";

/** The notturno job id this verb registers as (the registry's job truth). */
export const DISTILL_JOB = "distill";

/** The default nightly budget: how many eligible sessions one pass may
 *  consult (one Jev Choice each, the microdollar band; the stamp makes
 *  everything skipped free on later nights). */
export const DEFAULT_DISTILL_LIMIT = 20;

// ── the state stamp (re-runs are no-ops for already-distilled sessions) ──────

/** One stamped session: when it was distilled, what the pass found, and where
 *  the candidate note landed (null for an honest no-claim). */
export interface DistillStamp {
  distilled_at: string;
  claim_type: string;
  note: string | null;
}

export interface DistillState {
  schema_version: number;
  entries: Record<string, DistillStamp>;
}

/** Read the state stamp. Absent or malformed reads as EMPTY — fail-safe to
 *  re-distill (the retention-prefs doctrine: a corrupt preference must never
 *  widen what is skipped; re-consulting a session is cheap and idempotent by
 *  note-name). */
export function readDistillState(path: string): DistillState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DistillState;
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      return { schema_version: 1, entries: parsed.entries };
    }
  } catch {
    // absent/malformed → empty (fail-safe)
  }
  return { schema_version: 1, entries: {} };
}

/** Write the state stamp ATOMICALLY (tmp + rename, the thread-nouls map
 *  convention): a crash mid-pass must never leave a half-written stamp that
 *  would silently skip sessions. */
export function writeDistillState(path: string, state: DistillState): void {
  const tmp = `${path}.tmp-${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── the candidate claim-note ─────────────────────────────────────────────────

/** One session's evidence excerpt: a message row the verb just read —
 *  the pointer is the row's own id, so it resolves into the substrate by
 *  construction. */
export interface EvidenceExcerpt {
  messageId: string;
  role: "user" | "assistant";
  timeCreatedMs: number;
  text: string;
}

/** Everything the renderer needs: the substrate rows + the verdict + the
 *  run's provenance. Nothing here is invented — every field traces to a DB
 *  row or the pass context. */
export interface ClaimNoteFields {
  sessionId: string;
  sessionTitle: string;
  sessionCreatedMs: number;
  sessionUpdatedMs: number;
  sourceDb: string;
  distilledAt: string;
  claimType: string;
  confidence: number;
  evidence: EvidenceExcerpt[];
}

/** The note basename — deterministic + idempotent, keyed by session id: a
 *  re-distill (stamp lost) overwrites its own candidate rather than piling
 *  duplicates into the candidate area. */
export function claimNoteBasename(sessionId: string): string {
  return `claim-${sessionId}.md`;
}

/** The evidence-pointer vocabulary: kind + substrate row id. A pointer is
 *  resolvable iff the named row exists in the chat DB the note cites. */
export function sessionPointer(sessionId: string): string {
  return `chat-session/${sessionId}`;
}

export function messagePointer(messageId: string): string {
  return `chat-message/${messageId}`;
}

function yamlString(value: string): string {
  // JSON string quoting is valid YAML double-quote syntax; no escaping gaps.
  return JSON.stringify(value);
}

const EXCERPT_CHARS = 300;

function excerpt(text: string): string {
  return text.slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Render the candidate claim-note (frontmatter + body). Deterministic;
 *  provenance frontmatter carries the session id, both session timestamps,
 *  the source DB, and the full evidence-pointer list. The claim contract's
 *  lifecycle start state (`status: unverified`) is stamped here — machinery
 *  downstream (slice 5) owns every transition after it. */
export function renderClaimNote(f: ClaimNoteFields): string {
  const pointers = [
    sessionPointer(f.sessionId),
    ...f.evidence.map((e) => messagePointer(e.messageId)),
  ];

  const fm = [
    "---",
    "type: claim-candidate",
    `claim_type: ${f.claimType}`,
    "status: unverified",
    `confidence: ${f.confidence}`,
    `statement: ${yamlString(f.sessionTitle)}`,
    `session_id: ${yamlString(f.sessionId)}`,
    `session_title: ${yamlString(f.sessionTitle)}`,
    `source_db: ${yamlString(f.sourceDb)}`,
    `session_created: ${yamlString(iso(f.sessionCreatedMs))}`,
    `session_updated: ${yamlString(iso(f.sessionUpdatedMs))}`,
    `distilled_at: ${yamlString(f.distilledAt)}`,
    `distill_job: ${DISTILL_JOB}`,
    `evidence: [${pointers.map((p) => yamlString(p)).join(", ")}]`,
    "---",
  ].join("\n");

  const evidenceLines: string[] = [];
  for (const e of f.evidence) {
    evidenceLines.push(`- \`${messagePointer(e.messageId)}\` @ ${iso(e.timeCreatedMs)} (${e.role}): "${excerpt(e.text)}"`);
  }

  const body = [
    "",
    `# Claim candidate — ${f.sessionTitle}`,
    "",
    `> statement: ${f.sessionTitle}`,
    "",
    "Candidate claim-note generated by `amico distill` (notturno job `distill`, amicode #1680).",
    "A DRAFT for the dedupe + lifecycle passes — machinery never edits existing prose;",
    "the statement is the session's own title (the substrate's compression of the ask),",
    "typed by one confidence-gated Jev Choice; verify before corroborating.",
    "",
    "## Evidence",
    "",
    `- \`${sessionPointer(f.sessionId)}\` — the chat DB at \`${f.sourceDb}\`: session "${f.sessionTitle}"`,
    `  (created ${iso(f.sessionCreatedMs)}, last active ${iso(f.sessionUpdatedMs)})`,
    ...evidenceLines,
    "",
  ].join("\n");

  return fm + "\n" + body;
}

// ── the state-stamp updater (pure) ────────────────────────────────────────────

/** Fold one distilled session into the state. Returns a NEW state object —
 *  the caller writes it (or not, in dry-run). */
export function stampDistilled(
  state: DistillState,
  sessionId: string,
  claimType: string,
  note: string | null,
  distilledAt: string,
): DistillState {
  return {
    schema_version: 1,
    entries: {
      ...state.entries,
      [sessionId]: { distilled_at: distilledAt, claim_type: claimType === CLAIM_TYPE_NONE ? CLAIM_TYPE_NONE : claimType, note },
    },
  };
}

/** Write one claim-note into the candidate area (creating it). Returns the
 *  path written. */
export function writeClaimNote(candidatesDir: string, note: string, sessionId: string): string {
  const file = join(candidatesDir, claimNoteBasename(sessionId));
  if (!existsSync(candidatesDir)) mkdirSync(candidatesDir, { recursive: true });
  writeFileSync(file, note);
  return file;
}

/** The SALIENT evidence rows a claim-note cites — the same first/last-user and
 *  last-assistant rows the Jev fold reads. Digests, never spines: a long
 *  session's note carries its judgment's actual inputs (bounded), not every
 *  text part. Deterministic; order preserved from the rows. */
export function salientEvidence(rows: EvidenceExcerpt[]): EvidenceExcerpt[] {
  const users = rows.filter((r) => r.role === "user");
  const firstUser = users[0];
  const lastUser = users[users.length - 1];
  const lastAssistant = [...rows].reverse().find((r) => r.role === "assistant");
  const seen = new Set<string>();
  const out: EvidenceExcerpt[] = [];
  for (const r of [firstUser, lastUser, lastAssistant]) {
    if (r !== undefined && !seen.has(r.messageId)) {
      seen.add(r.messageId);
      out.push(r);
    }
  }
  return out;
}
