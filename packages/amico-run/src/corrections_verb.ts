// corrections_verb.ts — `amico corrections scan` (#1677): mine the chat DB for
// user messages that CORRECT system behavior (the pasqal-campaign lesson: the
// user's in-chat corrections are the highest-signal feedback the system gets,
// and they used to evaporate), classify the residual with the ONE Jev client,
// and file skills-integrity findings at `status: open` in the personal vault.
//
// DOCTRINE (the #1301/#1303/#1311 curation discipline, unchanged):
//   deterministic rules are the front line — the marker pre-filter owns RECALL
//   (a generous correction-signal regex + the junk-title vocabulary decide
//   WHICH messages are worth a call); Jev owns PRECISION and the kind/severity
//   labels, on the residual only, through the shared jev_client.ts (never a
//   second client); one JSONL receipt per attempted call (the client's job);
//   fail-open everywhere — no key, disabled, outage, or sub-threshold confidence
//   degrades to digest-only, never to a failed pass.
//
// GATE (the skills-integrity charter): detection is the autonomous fast ring —
// this verb files `open` findings and NOTHING more. Triage, fixes, proposals,
// merges: human-gated, always. `not-a-correction` never files; below-threshold
// confidence never files; unverified (jev unavailable) never files.
//
// CONVENTIONS: DRY-RUN BY DEFAULT (`--apply` writes findings + watermark +
// digest + Slack ping — the sessions-verb house rule); the chat DB opens
// READ-ONLY (`--db` flag → $OPENCODE_DB → the XDG default; sqlite_bridge.ts —
// never a writable connection for the scan); the pass watermark lives in the
// ops dir and applies ONLY when `--days` is not explicit (a backfill --days N
// forces the full window, per the issue's AC); vault writes target the
// personal mount (the amico-vault routing rule) — `--vault` overrides for
// tests, $AMICO_VAULTS_ROOT/$AMICO_VAULT_DIR already flow through mounts.ts.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev, jevDisabled, type JevDeps, type JevQuestion } from "./jev_client.js";
import type { JevPassStatus } from "./jev_curation.js";
import { isGreetingTitle } from "./session_junk.js";
import { amicodeOpsDir } from "./session_retention.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import { sqliteBatch } from "./sqlite_bridge.js";
import { resolveSessionDb } from "./sessions_verb.js";
import type { VerbResult } from "./verbs.js";

const USAGE =
  "amico corrections scan [--days <n>] [--apply] [--dry-run] [--max-jev <n>] [--db <path>] [--vault <path>] [--post <channel>]";

// ── the gates + budgets (named exports — no magic numbers at call sites) ──────

/** Default scan window: the last 7 days (rolling; the watermark narrows it). */
export const DEFAULT_SCAN_DAYS = 7;

/** Filing gate — the calibrated Choice confidence floor. Filing an OPEN
 *  finding is non-destructive (a human triages it), so this sits just under
 *  the archiver's destructive 0.95; tunable per the issue's Notes. */
export const CORRECTIONS_CONFIDENCE_MIN = 0.90;

/** Corroboration floor — the correction-noul must agree (p(true) ≥ 0.5). */
export const CORRECTIONS_NOUL_MIN = 0.5;

/** Jev budget: at most this many residual consultations per pass (the
 *  pre-filter is generous by design — the cap is the cost guard). */
export const DEFAULT_MAX_JEV = 200;

/** Digest unverified-entries cap (digest rows, never findings). */
export const DIGEST_UNVERIFIED_CAP = 20;

// ── the deterministic front line (recall) ────────────────────────────────────

/** Correction-signal markers — ONE match consults Jev. Generous by design:
 *  the regex owns recall, Jev owns precision; `--max-jev` caps the spend. */
export const CORRECTION_MARKERS: RegExp[] = [
  /\bno[ ,:;!?]/i,
  /\bnope\b/i,
  /\b(?:that'?s|that is|thats) (?:not|wrong)\b/i,
  /\byou'?re (?:wrong|misunderstanding|doing it wrong)\b/i,
  /\b(?:misunderstood|misunderstanding)\b/i,
  /\b(?:wrong|incorrect)\b/i,
  /\bnot what i\b/i,
  /\bi (?:said|told you|asked for|meant|wanted)\b/i,
  /\bi didn'?t (?:ask|say|want)\b/i,
  /\bstop\b/i,
  /\bdon'?t\b/i,
  /\binstead\b/i,
  /\bshould be (?:using|doing)\b/i,
  /\b(?:supposed to|you were supposed)\b/i,
  /\bwhy did you\b/i,
  /\byou should\b/i,
  /\b(?:again|still) (?:wrong|not)\b/i,
  /\bper my\b/i,
  /\bas i said\b/i,
  /\b(?:explicitly|specifically) (?:said|asked)\b/i,
  /\bwe agreed\b/i,
  /\bfor the (?:last|third) time\b/i,
  /\bi explicitly\b/i,
  /\bnot again\b/i,
];

/** The pre-filter (pure): one marker match ⇒ a Jev consultation candidate. */
export function isCorrectionCandidate(text: string): boolean {
  return CORRECTION_MARKERS.some((re) => re.test(text));
}

// ── the Jev middle layer (precision + labels) ─────────────────────────────────

/** The closed kind set — the four-way rubric; `not-a-correction` never files. */
export const CORRECTION_KINDS = ["skill-drift", "skill-gap", "behavior-gap", "not-a-correction"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export const KIND_RUBRIC: Record<CorrectionKind, string> = {
  "skill-drift":
    "the user is correcting behavior that a documented skill/instruction told the system to do — the documented behavior is wrong versus what the user wants or what reality does",
  "skill-gap":
    "the user is correcting behavior that no skill/instruction covers — a missing skill, a hand-rolled idiom the system improvised",
  "behavior-gap":
    "the user is correcting the agent's protocol or judgment — routing, campaign procedure, tool choice, how work is done — rather than a documented skill claim",
  "not-a-correction":
    "not a correction — new instructions, a clarification, a question, praise, thanks, or an unrelated remark",
};

/** The closed severity set — the skills-integrity ladder (P0 wrong-results →
 *  P3 gap). The Slack ping gate reads this, P0/P1 only. */
export const SEVERITIES = ["p0", "p1", "p2", "p3"] as const;
export type CorrectionSeverity = (typeof SEVERITIES)[number];

export const SEVERITY_RUBRIC: Record<CorrectionSeverity, string> = {
  p0: "following the system's current behavior would produce WRONG RESULTS — corrupted physics, data, or conclusions",
  p1: "the behavior is broken — the system failed at what it attempted, blocked work, or repeated a mistake that had already been corrected",
  p2: "drift — the system works but contradicts its documented instructions or skills",
  p3: "a gap — nothing covers the corrected behavior, but nothing broke",
};

/** One gather-eligible user message (the verb's DB rows map here OUTSIDE the
 *  Jev layer — the classifier stays a pure function of the candidate). */
export interface CorrectionCandidate {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  timeCreated: number;
  userText: string;
  precedingAssistantText: string;
}

/** Byte-clip a string for the Jev state fold (the 4096-byte state cap — bytes,
 *  not chars; a CJK char is 3–4 bytes and a naive slice would bust the cap). */
export function clipBytes(s: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= maxBytes) return s;
  let end = s.length;
  while (end > 0 && Buffer.byteLength(s.slice(0, end), "utf8") > maxBytes) end--;
  return s.slice(0, end);
}

const STATE_TITLE_BYTES = 200;
const STATE_USER_BYTES = 1500;
const STATE_ASSISTANT_BYTES = 2000;

/** The three questions over one state fold (ONE askJev call per candidate —
 *  one receipt, one latency, three verdicts). Pure builder, exported for
 *  hermetic tests. */
export function correctionsQuestions(c: CorrectionCandidate): {
  questions: Record<string, JevQuestion>;
  state: Record<string, string>;
} {
  return {
    questions: {
      correction: {
        type: "noul",
        instructions:
          "Is this user message a CORRECTION of what the assistant just did or said — telling it that it was wrong, should not have done that, or must do it differently?",
        criteria: {
          true: "the user is pushing back on, negating, or re-instructing behavior the assistant already produced — it did something wrong or unwanted",
          false: "the user is giving fresh instructions, asking a question, clarifying politely, thanking, or changing the subject — not correcting anything already done",
        },
      },
      kind: {
        type: "choice",
        instructions: "Classify the correction into exactly one kind. Judge by what the user is correcting, not by its tone.",
        criteria: KIND_RUBRIC,
      },
      severity: {
        type: "choice",
        instructions: "How severe is the corrected behavior, on the skills-integrity ladder? Judge the consequence of the system's mistake, not its cause.",
        criteria: SEVERITY_RUBRIC,
      },
    },
    state: {
      session_title: clipBytes(c.sessionTitle, STATE_TITLE_BYTES),
      user_message: clipBytes(c.userText, STATE_USER_BYTES),
      preceding_assistant_text: clipBytes(c.precedingAssistantText, STATE_ASSISTANT_BYTES),
    },
  };
}

/** The per-candidate Jev verdict (all three reads, or the honest error). */
export interface CorrectionVerdict {
  noul?: number;
  kind?: string;
  kind_confidence?: number;
  severity?: string;
  error?: string;
}

/** The filing gate (pure): a kind-carrying correction at ≥ 0.90 confidence,
 *  corroborated by the noul at ≥ 0.5. `not-a-correction` never files;
 *  anything below threshold never files. */
export function filingAdmits(kind: string | undefined, kindConfidence: number, noul: number): boolean {
  if (kind === undefined) return false;
  if (!(CORRECTION_KINDS as readonly string[]).includes(kind)) return false;
  if (kind === "not-a-correction") return false;
  return kindConfidence >= CORRECTIONS_CONFIDENCE_MIN && noul >= CORRECTIONS_NOUL_MIN;
}

/** Normalize a severity answer to the skills-integrity P-ladder label. */
export function severityOf(sev: string | undefined): string {
  const s = (sev ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? s.toUpperCase() : "P2";
}

/** P0/P1 severities ping Slack; everything else files silently. */
export function pingWorthy(sev: string): boolean {
  return sev === "P0" || sev === "P1";
}

/** The kind → finding-type mapping (TEMPLATE.md's two shapes): drift is a
 *  finding; gaps (skill or behavior) are proposals — repeated corrections ARE
 *  the proposal's evidence. */
export function findingTypeOf(kind: CorrectionKind): "skill-finding" | "skill-proposal" {
  return kind === "skill-drift" ? "skill-finding" : "skill-proposal";
}

/** One admitted correction occurrence (the provenance the templates demand). */
export interface AdmittedCorrection {
  candidate: CorrectionCandidate;
  kind: CorrectionKind;
  severity: string;
  kindConfidence: number;
  noul: number;
}

/** The cluster key: repeated corrections of the same behavior within one
 *  session collapse into ONE finding with N provenance-tagged occurrences
 *  (the skill-proposal claim format). */
export function clusterKey(a: AdmittedCorrection): string {
  return `${a.candidate.sessionId}:${a.kind}`;
}

// ── the gather (deterministic; READ-ONLY) ─────────────────────────────────────

/** User messages that FOLLOW an assistant text turn, in top-level unarchived
 *  sessions, with their text parts concatenated and the preceding assistant
 *  text excerpt — the role/json_extract shapes the sessions verb + open-threads
 *  reader already use against this DB. */
export const CORRECTIONS_GATHER_SQL = `
  SELECT m.id AS message_id, m.session_id, s.title, m.time_created,
    (SELECT group_concat(json_extract(p.data, '$.text'), ' ')
       FROM part p
       WHERE p.message_id = m.id
         AND json_extract(p.data, '$.type') = 'text'
         AND json_extract(p.data, '$.text') IS NOT NULL) AS user_text,
    (SELECT json_extract(p2.data, '$.text') FROM part p2
       JOIN message m2 ON m2.id = p2.message_id
       WHERE p2.session_id = m.session_id
         AND json_extract(m2.data, '$.role') = 'assistant'
         AND json_extract(p2.data, '$.type') = 'text'
         AND length(json_extract(p2.data, '$.text')) > 0
         AND m2.time_created < m.time_created
       ORDER BY p2.time_created DESC LIMIT 1) AS prev_assistant_text
  FROM message m
  JOIN session s ON s.id = m.session_id
  WHERE json_extract(m.data, '$.role') = 'user'
    AND s.parent_id IS NULL
    AND s.time_archived IS NULL
    AND m.time_created > ?
  ORDER BY m.time_created, m.id`;

// ── the watermark (ops dir; applies only without an explicit --days) ───────────

export function correctionsWatermarkFile(env: NodeJS.ProcessEnv): string {
  return join(amicodeOpsDir(env), "corrections-watermark.json");
}

export function readWatermarkMs(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(correctionsWatermarkFile(env), "utf8")) as { last_scanned_ms?: unknown };
    const ms = Number(parsed.last_scanned_ms);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

export function writeWatermarkMs(env: NodeJS.ProcessEnv, ms: number): void {
  const file = correctionsWatermarkFile(env);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema_version: 1, last_scanned_ms: ms, updated_at: new Date(ms).toISOString() }, null, 2) + "\n");
}

/** The effective window (pure): the --days cutoff, narrowed by the watermark
 *  ONLY when --days was not explicitly passed (a backfill --days forces the
 *  full window, per the issue's AC — and the nightly job runs without --days). */
export function effectiveSinceMs(now: number, days: number, daysExplicit: boolean, watermarkMs: number | undefined): number {
  const cutoff = now - days * 86_400_000;
  if (daysExplicit || watermarkMs === undefined) return cutoff;
  return Math.max(cutoff, watermarkMs);
}

// ── the findings writer (personal vault; TEMPLATE.md shapes) ───────────────────

/** Resolve the scan's vault root (the personal mount — the amico-vault
 *  routing rule): `--vault` flag, else the resolved personal mount, else
 *  undefined (and the scan reports it honestly instead of guessing). */
export function resolveVaultRoot(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--vault");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  const mount = personalMount(resolveMountStack());
  return mount === undefined ? undefined : mount.path;
}

export function findingsDirOf(vaultRoot: string): string {
  return join(vaultRoot, "amicode", "skills-integrity", "findings");
}

export function digestFileOf(vaultRoot: string): string {
  return join(vaultRoot, "dashboards", "user-corrections.md");
}

export const DIGEST_HEADER = `---
type: dashboard
subtype: user-corrections
source: corrections-scan
---

# User corrections

One section per corrections-scan pass, newest at the bottom. Auto-maintained by
\`amico corrections scan --apply\`; triage happens in the skills-integrity loop,
application stays human-gated.
`;

function slugOf(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug === "" ? "correction" : slug;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function quoteBlock(text: string, maxChars = 400): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `> ${t.length > maxChars ? `${t.slice(0, maxChars)}…` : t}`;
}

/** The scan's id namespace — collision-free against the human Fxx/Sxx scheme
 *  (the CS prefix says "auto-filed by corrections-scan" on its face). */
export function scanId(seq: number): string {
  return `CS-${seq}`;
}

/** Render one finding note per the skills-integrity TEMPLATE shapes (drift →
 *  skill-finding; gaps → skill-proposal with the occurrences as evidence).
 *  `seq` is the pass-scoped sequence — the CS- id namespace. */
export function renderFinding(a: AdmittedCorrection[], passIso: string, seq: number): { filename: string; content: string } {
  const first = a[0]!;
  const date = isoDate(first.candidate.timeCreated);
  const slug = slugOf(first.candidate.sessionTitle);
  const type = findingTypeOf(first.kind);
  const id = scanId(seq);
  const occurrences = a
    .map(
      (o) =>
        `- ${o.candidate.sessionId} ${new Date(o.candidate.timeCreated).toISOString()} (kind ${o.kind}, ${o.severity}, confidence ${o.kindConfidence.toFixed(2)}):\n` +
        `  ${quoteBlock(o.candidate.userText)}` +
        (o.candidate.precedingAssistantText.trim() !== "" ? `\n  correcting:\n  ${quoteBlock(o.candidate.precedingAssistantText, 200)}` : ""),
    )
    .join("\n");
  const autoNote = `\nAuto-filed by \`amico corrections scan\` (pass ${passIso}) — kind \`${first.kind}\`, severity ${a.map((o) => o.severity).join("/")}, Jev confidence ${first.kindConfidence.toFixed(2)}, noul ${first.noul.toFixed(2)}. Triage: the skills-integrity loop, step 3. Application is human-gated.\n`;
  const frontmatter =
    type === "skill-finding"
      ? [
          "---",
          "type: skill-finding",
          `date: ${date}`,
          `finding_id: ${id}`,
          `severity: ${a[0]!.severity}`,
          "status: open",
          `session_id: "${first.candidate.sessionId}"`,
          `source: "corrections-scan pass ${passIso}"`,
          "skills: []",
          `tags: [corrections-scan, ${first.kind}]`,
          `correction_kind: ${first.kind}`,
          "corrections_scan: true",
          "---",
          "",
        ].join("\n")
      : [
          "---",
          "type: skill-proposal",
          `date: ${date}`,
          `proposal_id: ${id}`,
          "status: open",
          `session_id: "${first.candidate.sessionId}"`,
          "evidence:",
          ...a.map((o) => `  - "${o.candidate.sessionId} ${new Date(o.candidate.timeCreated).toISOString()}: ${o.candidate.userText.replace(/\s+/g, " ").trim().slice(0, 160)}"`),
          `tags: [corrections-scan, new-skill, ${first.kind}]`,
          `correction_kind: ${first.kind}`,
          "corrections_scan: true",
          "---",
          "",
        ].join("\n");
  const body =
    type === "skill-finding"
      ? `**Claim** — the system's documented behavior was corrected by the user (skill-drift, per the scan's classification).\n\n**User correction (verbatim):**\n${occurrences}\n\n**Operational consequence** — TBD by triage.\n**Fix shape** — TBD by triage.\n${autoNote}`
      : `**The idiom** — the user had to correct un-skilled system behavior (${first.kind}); the occurrences below are the proposal's evidence.\n\n**Occurrences (${a.length}):**\n${occurrences}\n\n**Proposed skill purpose** — cover the corrected behavior so it stops being improvised.\n**Nearest existing skill** — TBD by triage.\n${autoNote}`;
  return { filename: `${type === "skill-finding" ? "finding" : "proposal"}-${date}-cs${seq}-${slug}.md`, content: frontmatter + body };
}

/** Find an existing OPEN scan finding for the same session + kind — the
 *  cross-pass dedup (append an UPDATE, never a duplicate file). Naive
 *  frontmatter scan: the scan's own files carry flat scalar keys. */
export function findExistingScanFinding(dir: string, sessionId: string, kind: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!content.includes("corrections_scan: true")) continue;
    if (!content.includes(`correction_kind: ${kind}`)) continue;
    if (!content.includes(`session_id: "${sessionId}"`)) continue;
    if (!/\bstatus:\s*open\b/.test(content)) continue;
    return join(dir, name);
  }
  return undefined;
}

/** The UPDATE section appended to an existing open finding (TEMPLATE rule:
 *  updates append; the original claim is never rewritten). */
export function renderUpdate(a: AdmittedCorrection[], passIso: string): string {
  const first = a[0]!;
  return `\n## UPDATE ${isoDate(Date.now())}\n\nCorrections-scan pass ${passIso} re-observed this correction:\n\n- ${first.candidate.sessionId} ${new Date(first.candidate.timeCreated).toISOString()} (kind ${first.kind}, ${first.severity}, confidence ${first.kindConfidence.toFixed(2)}):\n  ${quoteBlock(first.candidate.userText)}\n`;
}

/** Render one digest dashboard section for a pass. */
export function renderDigestSection(p: {
  passIso: string;
  days: number;
  sinceIso: string;
  scanned: number;
  candidates: number;
  jevStatus: string;
  filed: { path: string; type: string; kind: string; severity: string; occurrences: number }[];
  unverified: { sessionId: string; excerpt: string }[];
  overflow: number;
  pinged: string | undefined;
}): string {
  const lines = [
    `## Pass ${p.passIso} — corrections-scan`,
    "",
    `- window: ${p.days}d (since ${p.sinceIso}); scanned ${p.scanned} messages, ${p.candidates} correction candidates; jev: ${p.jevStatus}`,
    `- filed: ${p.filed.length} finding(s)${p.filed.length > 0 ? ` — ${p.filed.map((f) => `${f.type} ${f.severity} ${f.kind} (${f.occurrences}×) ${f.path}`).join("; ")}` : ""}`,
  ];
  if (p.unverified.length > 0) {
    lines.push(`- unverified candidates (jev ${p.jevStatus} — nothing filed, listed for the eye): ${p.unverified.length}`);
    for (const u of p.unverified) lines.push(`  - ${u.sessionId}: ${u.excerpt}`);
  }
  if (p.overflow > 0) lines.push(`- overflow: ${p.overflow} candidate(s) past the --max-jev cap were not judged this pass`);
  if (p.pinged !== undefined) lines.push(`- slack: P0/P1 ping sent to ${p.pinged}`);
  lines.push("");
  return lines.join("\n");
}

// ── the Slack ping (the amico-slack subprocess contract — fleet_digest's) ──────

/** $AMICO_CORRECTIONS_SLACK_CHANNEL; --post wins over it, absent → no ping. */
export function pingChannel(argv: string[], env: NodeJS.ProcessEnv): string {
  const i = argv.indexOf("--post");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  const v = env.AMICO_CORRECTIONS_SLACK_CHANNEL;
  return v && v.trim() !== "" ? v.trim() : "";
}

/** The subprocess contract: `amico-slack send <ch> --file <f>` (no Slack API
 *  code here — the same contract fleet_digest posts through). */
export function postViaAmicoSlack(channel: string, text: string): { ok: boolean; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), "amico-corrections-"));
  try {
    const file = join(dir, "ping.md");
    writeFileSync(file, text, "utf8");
    const r = spawnSync("amico-slack", ["send", channel, "--file", file], { encoding: "utf8", timeout: 60_000 });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      return { ok: false, error: code === "ENOENT" ? "amico-slack not found on PATH" : String(r.error.message) };
    }
    if (r.status !== 0) {
      const tail = ((r.stderr || "") + "\n" + (r.stdout || "")).trim().split("\n").pop() ?? "";
      return { ok: false, error: tail || `amico-slack exit ${r.status}` };
    }
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the scan deps (injectable — the suite runs hermetically) ───────────────────

export interface CorrectionsDeps {
  /** The middle-layer seam: default = the askJev loop below (receipts,
   *  fail-open); tests inject verdicts. */
  jev?: (candidates: CorrectionCandidate[]) => Promise<{ status: JevPassStatus; verdicts: Record<string, CorrectionVerdict> }>;
  /** The Slack seam: default = the amico-slack subprocess contract. */
  post?: (channel: string, text: string) => { ok: boolean; error?: string };
}

/** The default middle layer: ONE askJev call per candidate (three questions,
 *  one receipt), unavailable/disabled short-circuits the whole pass — the
 *  curation loop convention (no call is made after unavailability is known). */
async function jevCorrections(
  candidates: CorrectionCandidate[],
  deps: { env: NodeJS.ProcessEnv; jev?: JevDeps },
): Promise<{ status: JevPassStatus; verdicts: Record<string, CorrectionVerdict> }> {
  const verdicts: Record<string, CorrectionVerdict> = {};
  for (const c of candidates) {
    const { questions, state } = correctionsQuestions(c);
    const res = await askJev(questions, state, { sessionId: c.sessionId, deps: deps.jev ?? { env: deps.env } });
    if (!res.ok) {
      if (res.reason === "disabled" || res.reason === "key-missing")
        return { status: res.reason === "disabled" ? "disabled" : "unavailable", verdicts };
      verdicts[c.messageId] = { error: res.error };
      continue;
    }
    const correction = res.answers.correction;
    const kind = res.answers.kind;
    const severity = res.answers.severity;
    if (correction === undefined || kind === undefined || severity === undefined || correction.type !== "noul" || kind.type !== "choice" || severity.type !== "choice") {
      verdicts[c.messageId] = { error: "jev returned an incomplete answer set" };
      continue;
    }
    verdicts[c.messageId] = { noul: correction.noul, kind: kind.choice, kind_confidence: kind.confidence, severity: severity.choice };
  }
  return { status: "ran", verdicts };
}

// ── the verb ──────────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "corrections", error, ...extra }, code: 64 };
}

export async function correctionsScan(argv: string[], env: NodeJS.ProcessEnv, deps: CorrectionsDeps = {}): Promise<VerbResult> {
  const daysFlag = flagValue(argv, "--days");
  const days = daysFlag !== undefined ? Number(daysFlag) : DEFAULT_SCAN_DAYS;
  if (!Number.isInteger(days) || days < 1) return fail(`--days must be a positive integer, got ${daysFlag}`);
  const maxJev = flagValue(argv, "--max-jev") !== undefined ? Number(flagValue(argv, "--max-jev")) : DEFAULT_MAX_JEV;
  if (!Number.isInteger(maxJev) || maxJev < 1) return fail(`--max-jev must be a positive integer, got ${flagValue(argv, "--max-jev")}`);
  // dry-run by default (the sessions-verb house rule); --dry-run pins it.
  const apply = hasFlag(argv, "--apply") && !hasFlag(argv, "--dry-run");
  const dbPath = resolveSessionDb(argv, env);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const vaultRoot = resolveVaultRoot(argv, env);
  if (vaultRoot === undefined)
    return fail("no personal vault mount found — pass --vault <path> (or fix the mount stack; the scan never guesses a findings target)");

  const now = Date.now();
  const since = effectiveSinceMs(now, days, daysFlag !== undefined, readWatermarkMs(env));

  // ── gather (READ-ONLY) + deterministic pre-filter (recall) ──────────────
  let rows: Record<string, unknown>[];
  try {
    rows = sqliteBatch(dbPath, "ro", [{ sql: CORRECTIONS_GATHER_SQL, params: [since] }]).results[0]!.rows;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const all: CorrectionCandidate[] = rows
    .filter((r) => r.user_text !== null && r.user_text !== undefined && String(r.user_text).trim() !== "" && r.prev_assistant_text !== null)
    .map((r) => ({
      messageId: String(r.message_id),
      sessionId: String(r.session_id),
      sessionTitle: String(r.title),
      timeCreated: Number(r.time_created),
      userText: String(r.user_text),
      precedingAssistantText: String(r.prev_assistant_text),
    }))
    .filter((c) => !isGreetingTitle(c.sessionTitle) && isCorrectionCandidate(c.userText));

  // ── the middle layer (precision) — capped, fail-open ────────────────────
  const judged = all.slice(0, maxJev);
  const overflow = all.length - judged.length;
  let jevStatus: JevPassStatus | "error" = "ran";
  let verdicts: Record<string, CorrectionVerdict> = {};
  if (!jevDisabled(env)) {
    try {
      const pass = deps.jev !== undefined ? await deps.jev(judged) : await jevCorrections(judged, { env });
      jevStatus = pass.status;
      verdicts = pass.verdicts;
    } catch (e) {
      jevStatus = "error";
    }
  } else {
    jevStatus = "disabled";
  }

  // ── the gate (admitted findings) + clustering ────────────────────────────
  const admitted: AdmittedCorrection[] = [];
  for (const c of judged) {
    const v = verdicts[c.messageId];
    if (v === undefined || v.error !== undefined || v.kind === undefined) continue;
    if (!filingAdmits(v.kind, v.kind_confidence ?? 0, v.noul ?? 0)) continue;
    admitted.push({ candidate: c, kind: v.kind as CorrectionKind, severity: severityOf(v.severity), kindConfidence: v.kind_confidence ?? 0, noul: v.noul ?? 0 });
  }
  const clusters = new Map<string, AdmittedCorrection[]>();
  for (const a of admitted) {
    const key = clusterKey(a);
    clusters.set(key, [...(clusters.get(key) ?? []), a]);
  }

  // ── filing (apply only; dedup via UPDATE appends; watermark; digest; ping) ─
  const passIso = new Date(now).toISOString();
  const filed: { path: string; type: string; kind: string; severity: string; occurrences: number }[] = [];
  const updated: string[] = [];
  const findingsDir = findingsDirOf(vaultRoot);
  if (apply && jevStatus === "ran") {
    mkdirSync(findingsDir, { recursive: true });
    let seq = 0;
    for (const list of clusters.values()) {
      const first = list[0]!;
      const existing = findExistingScanFinding(findingsDir, first.candidate.sessionId, first.kind);
      if (existing !== undefined) {
        writeFileSync(existing, readFileSync(existing, "utf8").replace(/\n+$/, "") + renderUpdate(list, passIso));
        updated.push(existing);
        continue;
      }
      seq++;
      const { filename, content } = renderFinding(list, passIso, seq);
      const target = join(findingsDir, filename);
      writeFileSync(target, content);
      filed.push({ path: target, type: findingTypeOf(first.kind), kind: first.kind, severity: first.severity, occurrences: list.length });
    }
    writeWatermarkMs(env, now);
  }

  // ── the digest (apply only) ──────────────────────────────────────────────
  // "unverified" = candidates Jev never cleanly judged: the whole pass
  // unavailable/disabled, or the individual call failed (error verdict) —
  // digest rows for the eye, never findings.
  const unverifiedList = judged
    .filter((c) => jevStatus !== "ran" || (verdicts[c.messageId] !== undefined && verdicts[c.messageId]!.error !== undefined))
    .slice(0, DIGEST_UNVERIFIED_CAP)
    .map((c) => ({
      sessionId: c.sessionId,
      excerpt: c.userText.replace(/\s+/g, " ").trim().slice(0, 120),
    }));
  const digestFile = digestFileOf(vaultRoot);
  let ping: { ok: boolean; error?: string; channel?: string } | undefined;
  if (apply) {
    const section = renderDigestSection({
      passIso,
      days,
      sinceIso: new Date(since).toISOString(),
      scanned: rows.length,
      candidates: all.length,
      jevStatus,
      filed,
      unverified: [...unverifiedList, ...(jevStatus === "ran" ? [] : judged.slice(DIGEST_UNVERIFIED_CAP).map((c) => ({ sessionId: c.sessionId, excerpt: "…" })))].slice(0, DIGEST_UNVERIFIED_CAP),
      overflow,
      pinged: undefined,
    });
    mkdirSync(join(digestFile, ".."), { recursive: true });
    if (existsSync(digestFile)) {
      writeFileSync(digestFile, readFileSync(digestFile, "utf8").replace(/\n+$/, "") + "\n\n" + section.replace(/\n+$/, "") + "\n");
    } else {
      writeFileSync(digestFile, DIGEST_HEADER + "\n" + section.replace(/\n+$/, "") + "\n");
    }
    // ── the P0/P1 ping (fail-open: a failed post is a warning, never a failed pass) ──
    const channel = pingChannel(argv, env);
    const pings = filed.filter((f) => pingWorthy(f.severity));
    if (channel !== "" && pings.length > 0) {
      const text = [`corrections-scan ${passIso}: ${pings.length} P0/P1 finding(s) filed`, "", ...pings.map((f) => `- ${f.severity} ${f.kind} (${f.occurrences}×): ${f.path}`)].join("\n");
      const post = deps.post !== undefined ? deps.post(channel, text) : postViaAmicoSlack(channel, text);
      ping = { ...post, channel };
      writeFileSync(digestFile, readFileSync(digestFile, "utf8").replace(/\n+$/, "") + `\n- slack: ${post.ok ? `P0/P1 ping sent to ${channel}` : `ping FAILED (${post.error ?? "unknown"}) — findings are still filed`}\n`);
    }
  }

  return {
    json: {
      verb: "corrections",
      subcommand: "scan",
      dry_run: !apply,
      days,
      since_ms: since,
      since_iso: new Date(since).toISOString(),
      scanned: rows.length,
      candidates: all.length,
      judged: judged.length,
      overflow,
      jev_status: jevStatus,
      admitted: admitted.length,
      clusters: clusters.size,
      filed,
      updated,
      unverified: unverifiedList.length,
      watermark_path: apply ? correctionsWatermarkFile(env) : undefined,
      digest_path: apply ? digestFile : undefined,
      ping,
      note: apply ? undefined : "dry-run: nothing written — pass --apply to file findings, write the watermark, and update the digest",
    },
    code: 0,
  };
}

/** The `corrections` verb body: route on the subcommand. Backs BOTH the CLI
 *  (amico.ts — SPINE_VERBS dispatch) and the MCP facade (mcp_serve.ts — the
 *  registry auto-publishes `amico_corrections`): one impl, two transports. */
export async function correctionsVerb(argv: string[]): Promise<VerbResult> {
  const sub = argv[0];
  if (sub === "scan") return correctionsScan(argv.slice(1), process.env);
  return {
    json: {
      verb: "corrections",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: USAGE,
    },
    code: 64,
  };
}
