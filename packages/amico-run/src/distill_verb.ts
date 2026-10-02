// distill_verb.ts — `amico distill` (amicode #1680, brain flywheel slice 1 —
// the artery): the nightly notturno job that distills the classified-substantive
// session backlog of the chat DB into candidate claim-notes.
//
// THE WORKLIST CONTRACT (the issue's key decision): the substantive/junk split
// is #1304's classification — the SAME classifySession over the SAME feature
// query shape as `amico sessions autoarchive`, never a second classifier. Junk
// sessions are classified and then NEVER READ for distillation: their content
// is never pulled, never sent to the middle layer, never rendered. Only
// top-level (parent_id IS NULL) unarchived sessions are candidates — the
// thread-noul sweep's window convention.
//
// THE MIDDLE LAYER (the #1311 discipline, third call site): ONE Jev Choice per
// eligible session over the parent claim contract's closed type set
// (jev_curation.ts jevClaimTypes — the typing gate only; statements + evidence
// are deterministic projections of the substrate rows). Disabled/unavailable is
// a NAMED no-op: nothing stamped, nothing distilled, honest counts, exit 0.
//
// ONE SUBSTRATE (the #1679 invariant): the chat DB is opened READ-ONLY
// (sqlite_bridge `ro` — the open-threads discipline; this verb never writes a
// byte to the store). Its outputs are projections: candidate notes in a
// dedicated candidate area, a state stamp in the ops dir, a pass receipt in the
// notturno journal — each with provenance pointers back.
//
// MODES (the S2 convention): dry-run by default (report-only: no Jev calls, no
// writes, no receipt); `--apply` writes. dry/apply are explicit in the JSON.
//
// THE RECEIPT: with `--registry` (+ `--dashboards`), every run files (or
// honestly skips) a scheduled-passes.md record through the notturno_passes
// writer — job name `distill`, counts in the outcome, duration, note
// artifacts. The chassis gates apply verbatim on every exit path: the
// instance deny-list first (org config never runs through this public verb),
// then the registry membership check (an unknown job id is exit 2), then the
// record mode (`acted` jobs self-filter when the pass distilled nothing — the
// briefs precedent). Without `--registry` the body still runs and the receipt
// is honestly not filed (the weekly-synthesis seam: a private instance
// composes its own receipt through its own runner).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifySession, type SessionFeatures } from "./session_junk.js";
import { jevClaimTypes, CLAIM_TYPES, CLAIM_TYPE_NONE, type ClaimTypeCandidate, type ClaimTypeVerdict, type JevPassStatus } from "./jev_curation.js";
import { jevDisabled } from "./jev_client.js";
import { sqliteBatch } from "./sqlite_bridge.js";
import { resolveSessionDb } from "./sessions_verb.js";
import { amicodeOpsDir } from "./session_retention.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import { deniedBy, discoverDenyList, loadDenyList, loadRegistry } from "./notturno_registry.js";
import { appendSection, renderPass } from "./notturno_passes.js";
import {
  DEFAULT_DISTILL_LIMIT,
  DISTILL_JOB,
  readDistillState,
  renderClaimNote,
  salientEvidence,
  stampDistilled,
  writeClaimNote,
  writeDistillState,
  type DistillState,
} from "./distill.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico distill [--db <path>] [--candidates <dir>] [--state <path>] [--limit <n>] [--session <id>]",
  "              [--apply] [--registry <p>] [--dashboards <dir|file>]",
  "",
  "  dry-run by default (report-only); --apply writes candidate claim-notes,",
  "  the distill state stamp, and (with --registry + --dashboards) the notturno",
  "  pass receipt. Worklist: #1304's substantive classification of the chat DB.",
].join("\n");

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "distill", error, usage: USAGE, ...extra }, code: 64 };
}

/** The default candidate area: the personal mount's `amicode/claims/candidates/`
 *  subtree (the amico-vault layout: amicode state lives under `amicode/`).
 *  No personal mount → the caller demands --candidates explicitly (the
 *  dream-distill resolution doctrine: never guess a vault). */
function defaultCandidatesDir(env: NodeJS.ProcessEnv): string | undefined {
  const stack = resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML);
  const mount = personalMount(stack);
  return mount === undefined ? undefined : join(mount.path, "amicode", "claims", "candidates");
}

// The worklist query: per unarchived top-level session, the #1303 classifier's
// feature fold — the SAME shapes `amico sessions autoarchive` maps (its
// AUTOARCHIVE_FEATURES_SQL, plus the session timestamps the candidate notes
// cite as provenance). The classification runs on THESE rows only; junk
// sessions go no further.
const DISTILL_WORKLIST_SQL = `
  SELECT s.id, s.title, s.time_created, s.time_updated,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id
       AND json_extract(m.data, '$.role') = 'user') AS user_message_count,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id
       AND json_extract(m.data, '$.role') = 'assistant') AS assistant_message_count,
    (SELECT COALESCE(SUM(length(json_extract(p.data, '$.text'))), 0)
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = s.id AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text') AS user_text_chars,
    (SELECT COUNT(*) FROM todo t WHERE t.session_id = s.id
       AND t.status != 'completed') AS todo_count
  FROM session s
  WHERE s.parent_id IS NULL AND s.time_archived IS NULL
  ORDER BY s.time_updated DESC, s.id`;

/** The content pull — eligible (substantive) sessions ONLY: junk rows are
 *  never read for distillation (AC 3). Text parts in time order, user and
 *  assistant roles. */
const DISTILL_CONTENT_SQL = `
  SELECT p.session_id, p.message_id, p.time_created, json_extract(m.data, '$.role') AS role,
    json_extract(p.data, '$.text') AS text
  FROM part p JOIN message m ON m.id = p.message_id
  WHERE p.session_id IN (SELECT value FROM json_each(?))
    AND json_extract(p.data, '$.type') = 'text'
    AND length(json_extract(p.data, '$.text')) > 0
    AND json_extract(m.data, '$.role') IN ('user', 'assistant')
  ORDER BY p.time_created, p.message_id`;

/** The jev seam — injectable so the suite runs hermetically (the #1311 shape). */
export interface DistillDeps {
  jev?: (candidates: ClaimTypeCandidate[]) => Promise<{ status: JevPassStatus; verdicts: Record<string, ClaimTypeVerdict> }>;
  now?: () => Date;
}

interface WorklistRow {
  id: string;
  title: string;
  time_created: number;
  time_updated: number;
  bucket: string;
  features: SessionFeatures;
}

/** The run's tally — the receipt's outcome line and the JSON share one shape. */
interface Tally {
  scanned: number;
  substantive: number;
  junk: number;
  distilled: number;
  claims: number;
  noClaim: number;
  errors: number;
}

function outcomeLine(t: Tally): string {
  return `distill: scanned ${t.scanned} sessions (substantive ${t.substantive}, junk ${t.junk}), distilled ${t.distilled}, claims ${t.claims}, none ${t.noClaim}, errors ${t.errors}`;
}

/** The deny gate (the notturno verb's semantics, the distill runner's hint):
 *  a registry named by an instance-deny-list row is org config — this public
 *  verb refuses to run it, pointing at the private instance's runner. */
function denyGate(registry: string, denyList: string | undefined): VerbResult | undefined {
  const manifest = denyList ?? discoverDenyList(registry);
  if (manifest === undefined) return undefined;
  const loaded = loadDenyList(manifest);
  if (!loaded.ok) return { json: { verb: "distill", ok: false, error: loaded.error }, code: 2 };
  const row = deniedBy(registry, loaded.deny);
  if (row === undefined) return undefined;
  return {
    json: {
      verb: "distill",
      ok: false,
      error: "registry is instance config — denied by the instance deny list",
      registry,
      deny: row,
      hint: "this registry is deny-listed instance data — run the distill job through the private instance's runner (automation/notturno) in the amicissimo checkout; the public amico CLI never runs org config",
    },
    code: 64,
  };
}

/** Resolve --registry or AMICO_NOTTURNO_REGISTRY (the notturno verb's order). */
function registryPath(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const flag = flagValue(argv, "--registry");
  if (flag !== undefined && flag !== "") return flag;
  const e = env.AMICO_NOTTURNO_REGISTRY;
  return e && e !== "" ? e : undefined;
}

/** The receipt step every terminal path shares: no registry → honestly not
 *  filed; else membership check (unknown job = data error 2), the record-mode
 *  self-filter (acted + nothing distilled → skipped), then the append. */
function distillReceipt(
  registry: string | undefined,
  dashboards: string | undefined,
  tally: Tally,
  artifacts: string[],
  durationMs: number,
  now: Date,
): { receipt: Record<string, unknown> } | { error: VerbResult } {
  if (registry === undefined) return { receipt: { filed: false, reason: "no --registry" } };
  const loaded = loadRegistry(registry);
  if (!loaded.ok) return { error: { json: { verb: "distill", ok: false, error: loaded.error }, code: 2 } };
  const job = loaded.registry.jobs.find((j) => j.id === DISTILL_JOB);
  if (job === undefined)
    return {
      error: {
        json: { verb: "distill", ok: false, error: `passes: unknown job '${DISTILL_JOB}' — not in the Notturno registry`, registry },
        code: 2,
      },
    };
  if (job.record === "acted" && tally.distilled === 0) {
    return { receipt: { filed: false, skipped: true, reason: `passes: ${job.id} records on action only; no action this run — skipped` } };
  }
  const target = appendSection(
    dashboards!,
    renderPass({
      job: job.id,
      status: "ok",
      outcome: outcomeLine(tally),
      duration_s: Math.round(durationMs / 1000),
      artifacts,
      when: now,
    }),
  );
  return { receipt: { filed: true, job: job.id, target } };
}

export async function distillVerb(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: DistillDeps = {},
): Promise<VerbResult> {
  const now = deps.now ?? (() => new Date());
  const valuedFlags = ["--db", "--candidates", "--state", "--limit", "--session", "--registry", "--dashboards", "--deny-list"];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (!name.startsWith("--")) return fail(`unexpected argument "${name}"`);
    if (name === "--apply") continue;
    if (valuedFlags.includes(name)) {
      if (argv[i + 1] === undefined) return fail(`flag "${name}" needs a value`);
      i++;
      continue;
    }
    return fail(`unknown flag "${name}"`);
  }
  const startedAt = Date.now();

  const db = resolveSessionDb(argv, env);
  if (!existsSync(db)) return fail(`session DB not found: ${db}`);

  const apply = hasFlag(argv, "--apply");
  const candidatesDir = flagValue(argv, "--candidates") ?? defaultCandidatesDir(env);
  if (candidatesDir === undefined)
    return fail("no personal vault mount resolved — pass --candidates <dir> explicitly (the candidate area is a dedicated dir, never a guess)");
  const statePath = flagValue(argv, "--state") ?? join(amicodeOpsDir(env), "distill-state.json");
  const limitRaw = flagValue(argv, "--limit");
  const limit = limitRaw === undefined ? DEFAULT_DISTILL_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) return fail(`--limit must be a positive integer, got ${limitRaw}`);
  const namedSession = flagValue(argv, "--session");
  const registry = registryPath(argv, env);
  const dashboards = flagValue(argv, "--dashboards");
  if (registry !== undefined && dashboards === undefined)
    return fail("the pass receipt needs its journal: --registry requires --dashboards <dir|file>");

  // the chassis deny gate fires BEFORE any DB work (org config is never read)
  if (registry !== undefined) {
    const denied = denyGate(registry, flagValue(argv, "--deny-list"));
    if (denied !== undefined) return denied;
  }

  // ── the worklist: #1304's classification over the feature fold ─────────
  let worklist: WorklistRow[];
  try {
    const batch = sqliteBatch(db, "ro", [{ sql: DISTILL_WORKLIST_SQL }]);
    worklist = batch.results[0].rows.map((r) => {
      const features: SessionFeatures = {
        title: String(r.title),
        user_message_count: Number(r.user_message_count),
        user_text_chars: Number(r.user_text_chars),
        assistant_message_count: Number(r.assistant_message_count),
        todo_count: Number(r.todo_count),
      };
      return {
        id: String(r.id),
        title: String(r.title),
        time_created: Number(r.time_created),
        time_updated: Number(r.time_updated),
        bucket: classifySession(features),
        features,
      };
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const named = namedSession !== undefined ? worklist.find((w) => w.id === namedSession) : undefined;
  if (namedSession !== undefined && named === undefined) return fail(`no such session: ${namedSession}`);

  // a named junk session is refused for distillation, honestly (AC 3)
  if (named !== undefined && named.bucket !== "substantive") {
    return {
      json: {
        verb: "distill",
        ok: true,
        dry_run: !apply,
        status: "ran",
        junk_named: namedSession,
        consulted: 0,
        distilled: 0,
        note: `session ${namedSession} classifies ${named.bucket} — junk is never read for distillation`,
      },
      code: 0,
    };
  }

  const substantiveRows = named !== undefined ? [named] : worklist.filter((w) => w.bucket === "substantive");
  const tally: Tally = {
    scanned: named !== undefined ? 1 : worklist.length,
    substantive: substantiveRows.length,
    junk: (named !== undefined ? 1 : worklist.length) - substantiveRows.length,
    distilled: 0,
    claims: 0,
    noClaim: 0,
    errors: 0,
  };

  // ── the state stamp: already-distilled sessions are no-ops (AC 2) ───────
  const state: DistillState = readDistillState(statePath);
  const unstamped = substantiveRows.filter((w) => state.entries[w.id] === undefined);
  const eligible = unstamped.slice(0, limit);
  const alreadyDistilled = substantiveRows.length - unstamped.length;

  const base = {
    verb: "distill",
    ok: true,
    dry_run: !apply,
    db,
    scanned: tally.scanned,
    substantive: tally.substantive,
    junk: tally.junk,
    already_distilled: alreadyDistilled,
    limit,
    candidates_dir: candidatesDir,
    state_path: statePath,
  };

  // dry-run is REPORT-ONLY: no Jev consultation, no writes, no receipt (AC 5)
  if (!apply) {
    return { json: { ...base, status: "ok", would_distill: eligible.length, eligible_ids: eligible.map((e) => e.id), consulted: 0 }, code: 0 };
  }

  const finish = (extra: Record<string, unknown>): VerbResult => {
    const receipt = distillReceipt(registry, dashboards, tally, (extra.notes as string[]) ?? [], Date.now() - startedAt, now());
    if ("error" in receipt) return receipt.error;
    return { json: { ...base, ...extra, receipt: receipt.receipt }, code: 0 };
  };

  // ── disabled jev: the zero-delta off-switch (nothing distilled, nothing stamped)
  if (jevDisabled(env)) {
    return finish({
      status: "disabled",
      consulted: 0,
      distilled: 0,
      claims: 0,
      no_claim: 0,
      errors: 0,
      note: "jev path disabled (AMICO_JEV_DISABLED) — zero delta; nothing distilled, nothing stamped",
    });
  }

  // ── nothing eligible: an honest no-op run (all distilled or empty worklist)
  if (eligible.length === 0) {
    return finish({
      status: "ran",
      consulted: 0,
      distilled: 0,
      claims: 0,
      no_claim: 0,
      errors: 0,
      note: "nothing eligible: every substantive session is already distilled (or the worklist is empty)",
    });
  }

  // ── the content pull — eligible sessions ONLY (junk never read, AC 3) ───
  interface ContentRow {
    session_id: string;
    message_id: string;
    time_created: number;
    role: string;
    text: string;
  }
  let content: ContentRow[];
  try {
    const batch = sqliteBatch(db, "ro", [
      { sql: DISTILL_CONTENT_SQL, params: [JSON.stringify(eligible.map((e) => e.id))] },
    ]);
    content = batch.results[0].rows.map((r) => ({
      session_id: String(r.session_id),
      message_id: String(r.message_id),
      time_created: Number(r.time_created),
      role: String(r.role),
      text: String(r.text),
    }));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // the digest-sized fold per session (first + last user ask, last assistant
  // conclusion) — the state-budget doctrine: excerpts, never spines
  const bySession = new Map<string, ContentRow[]>();
  for (const c of content) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, []);
    bySession.get(c.session_id)!.push(c);
  }
  const candidates: ClaimTypeCandidate[] = eligible.map((w) => {
    const rows = bySession.get(w.id) ?? [];
    const userTexts = rows.filter((r) => r.role === "user").map((r) => r.text);
    const lastAssistant = [...rows].reverse().find((r) => r.role === "assistant");
    return {
      id: w.id,
      title: w.title,
      userMessageCount: w.features.user_message_count,
      userTextChars: w.features.user_text_chars,
      assistantMessageCount: w.features.assistant_message_count,
      firstUserText: userTexts[0] ?? "",
      lastUserText: userTexts[userTexts.length - 1] ?? "",
      lastAssistantText: lastAssistant?.text ?? "",
    };
  });

  // ── the middle layer: ONE claim-type Choice per candidate ───────────────
  const pass = deps.jev !== undefined ? await deps.jev(candidates) : await jevClaimTypes(candidates, { env });

  if (pass.status !== "ran") {
    return finish({
      status: pass.status,
      consulted: 0,
      distilled: 0,
      claims: 0,
      no_claim: 0,
      errors: 0,
      note: `jev middle layer ${pass.status} — fail-open: nothing distilled, nothing stamped; the next pass retries these sessions`,
    });
  }

  // ── project: candidate notes + stamps (apply path) ─────────────────────
  const distilledAt = now().toISOString();
  let nextState = state;
  const notes: string[] = [];
  for (const c of candidates) {
    const verdict = pass.verdicts[c.id];
    if (verdict === undefined || verdict.error !== undefined) {
      tally.errors++;
      continue; // no stamp: the next pass retries the session
    }
    const choice = verdict.choice ?? CLAIM_TYPE_NONE;
    if (choice !== CLAIM_TYPE_NONE && !(CLAIM_TYPES as readonly string[]).includes(choice)) {
      tally.errors++;
      continue; // an off-rubric read is an error, never a guessed note
    }
    if (choice === CLAIM_TYPE_NONE) {
      tally.noClaim++;
      nextState = stampDistilled(nextState, c.id, CLAIM_TYPE_NONE, null, distilledAt);
      continue;
    }
    const work = eligible.find((e) => e.id === c.id)!;
    // the note cites the SALIENT rows — the same first/last-user and
    // last-assistant inputs the Jev fold read (digests, never spines)
    const evidence = salientEvidence(
      (bySession.get(c.id) ?? []).map((r) => ({
        messageId: r.message_id,
        role: r.role === "assistant" ? "assistant" : "user",
        timeCreatedMs: r.time_created,
        text: r.text,
      })),
    );
    const note = renderClaimNote({
      sessionId: c.id,
      sessionTitle: work.title,
      sessionCreatedMs: work.time_created,
      sessionUpdatedMs: work.time_updated,
      sourceDb: db,
      distilledAt,
      claimType: choice,
      confidence: verdict.confidence ?? 0,
      evidence,
    });
    const file = writeClaimNote(candidatesDir, note, c.id);
    notes.push(file);
    tally.claims++;
    nextState = stampDistilled(nextState, c.id, choice, file, distilledAt);
  }

  tally.distilled = tally.claims + tally.noClaim;
  if (tally.distilled > 0) writeDistillState(statePath, nextState);

  return finish({
    status: "ran",
    consulted: candidates.length,
    distilled: tally.distilled,
    claims: tally.claims,
    no_claim: tally.noClaim,
    errors: tally.errors,
    notes,
  });
}
