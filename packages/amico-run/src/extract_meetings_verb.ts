// extract_meetings_verb.ts — `amico extract-meetings` (amicode #1686, brain
// flywheel slice 7 — the meeting intake half): the weekly notturno job that
// triages the meeting vault's pending-tag backlog.
//
// THE CANON (the issue's key decision): the meeting vault's OWN registry —
// RULES.md, meeting-types.md, products.md, internal-projects.md — is the
// schema of record. No second tagging scheme: tier-1 proposals apply only the
// registry's enumerated values; tier-2 entities mint only from the note's own
// attendee canonicals + explicit partnership phrases; tier-3 themes are the
// canon's free-form tier. Where the closed vocabulary has no fit, the
// proposal NAMES THE GAP (triage.ts's TAGGING HONESTY) — never an invented tag.
//
// TRIAGE PROPOSES, HUMANS DISPOSE: the meeting vault is a READ-ONLY substrate
// here (it is ro-mounted on this machine by design). The verb never writes a
// byte to the vault it reads — --apply writes PROPOSALS to a --out the caller
// names: the tagged-note proposal (the note rewritten: tiers populated,
// context links resolvable, status flipped per the vault's own convention)
// under <out>/meetings/, and one hopper proposal per next step (with meeting
// provenance: a resolvable meeting-note pointer) under <out>/hopper/. A human
// (or a writable checkout of the vault repo) moves them home.
//
// IDEMPOTENCY (AC 4): deterministic basenames + deterministic bytes — re-runs
// overwrite their own proposals and move nothing; an already-tagged note
// (status != pending-tag) is an honest no-op.
//
// THE RECEIPT (AC 4): with --registry + --dashboards, every run files (or
// honestly skips) a notturno pass record through the same chassis gates as
// distill: the instance deny-list first (org config never runs through this
// public verb), then the registry membership check (unknown job id → exit 2),
// then the record-mode self-filter (acted jobs self-filter when the pass
// proposed nothing). Without --registry the body still runs and the receipt
// is honestly not filed.
//
// MODES: dry-run by default (report-only: no writes, no receipt); --apply
// writes. dry/apply are explicit in the JSON.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import {
  EXTRACT_MEETINGS_JOB,
  hopperBasename,
  loadMeetingCanon,
  parseNextSteps,
  proposeContextLinks,
  proposeMeetingTags,
  renderHopperProposal,
  rewriteMeetingNote,
  scanMeetingSeries,
  meetingSeriesKey,
  triageDenyGate,
  triageJobReceipt,
  type MeetingRef,
} from "./triage.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico extract-meetings <note.md> [--out <dir>] [--meetings <meeting vault root>]",
  "                        [--registry <p>] [--dashboards <dir|file>] [--deny-list <p>] [--apply]",
  "",
  "  Given a pending-tag meeting note, propose its three tag tiers (the vault",
  "  registry's closed vocabularies — gaps named, never invented), a context-links",
  "  section with resolvable links, and next-steps → hopper proposals with meeting",
  "  provenance. Dry-run by default; --apply writes the proposals to --out (default:",
  "  the personal mount's amicode/triage/) — the meeting vault itself is never written.",
  "  Idempotent: deterministic naming + bytes; already-tagged notes are no-ops.",
].join("\n");

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: EXTRACT_MEETINGS_JOB, error, usage: USAGE, ...extra }, code: 64 };
}

/** The meeting-vault root: --meetings, else the mount named `meeting-vault` in
 *  the resolved stack — never a guessed path. */
function meetingsRootFrom(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--meetings");
  if (i >= 0) return argv[i + 1];
  const stack = resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML);
  return stack.mounts.find((m) => m.name === "meeting-vault" || basename(m.path) === "meeting-vault")?.path;
}

/** The proposals root: --out, else the personal mount's amicode/triage/ staging
 *  area (the amico-vault layout: amicode state lives under amicode/). */
function outRootFrom(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--out");
  if (i >= 0) return argv[i + 1];
  const m = personalMount(resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML));
  return m === undefined ? undefined : join(m.path, "amicode", "triage");
}

export async function extractMeetingsVerb(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => Date } = {},
): Promise<VerbResult> {
  const now = deps.now ?? (() => new Date());
  const valuedFlags = ["--out", "--meetings", "--registry", "--dashboards", "--deny-list"];
  let note: string | undefined;
  let registry: string | undefined;
  let denyList: string | undefined;
  let dashboards: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (valuedFlags.includes(a)) {
      if (argv[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
      if (a === "--out" || a === "--meetings") {
        i++; // positional-resolution flags, consumed by the helpers below
        continue;
      }
      if (a === "--registry") registry = argv[i + 1];
      else if (a === "--dashboards") dashboards = argv[i + 1];
      else denyList = argv[i + 1];
      i++;
      continue;
    }
    if (note === undefined && !a.startsWith("--")) {
      note = a;
      continue;
    }
    return fail(`unexpected argument "${a}"`);
  }
  if (note === undefined) return fail("extract-meetings needs a meeting note: amico extract-meetings <note.md>");
  if (!existsSync(note)) return fail(`meeting note not found: ${note}`);
  if (registry !== undefined && dashboards === undefined) return fail("the pass receipt needs its journal: --registry requires --dashboards <dir|file>");

  const meetingsRoot = meetingsRootFrom(argv, env);
  if (meetingsRoot === undefined) {
    return fail("no meeting vault resolved — pass --meetings <meeting vault root> explicitly (the canon's registry is never a guess)");
  }
  const outRoot = outRootFrom(argv, env);
  if (outRoot === undefined) {
    return fail("no personal vault mount resolved — pass --out <dir> explicitly (the proposal area is a dedicated dir, never a guess)");
  }

  // the chassis deny gate fires BEFORE any vault work (org config is never read)
  if (registry !== undefined) {
    const denied = triageDenyGate(EXTRACT_MEETINGS_JOB, registry, denyList);
    if (denied !== undefined) return denied;
  }

  const raw = readFileSync(note, "utf8");
  const fm = parseFrontmatter(raw);
  if (!fm.ok) return fail(`${basename(note)}: ${fm.error}`);
  if (fm.data.type !== "meeting") {
    return fail(`${basename(note)}: not a meeting note (type: ${JSON.stringify(fm.data.type)}) — the triage surface is the meeting intake's own shape`);
  }
  const base = {
    verb: EXTRACT_MEETINGS_JOB,
    ok: true,
    note,
    meetings_root: meetingsRoot,
    out_root: outRoot,
  };

  // already tagged (or otherwise not pending) → the weekly pass's idempotent no-op
  if (fm.data.status !== "pending-tag") {
    const skipJson = {
      ...base,
      dry_run: !apply,
      skipped: `status is ${JSON.stringify(fm.data.status)}, not pending-tag — already triaged, nothing to do`,
      steps: 0,
    };
    if (!apply) return { json: skipJson, code: 0 };
    const receipt = triageJobReceipt(
      EXTRACT_MEETINGS_JOB,
      EXTRACT_MEETINGS_JOB,
      registry,
      dashboards,
      { outcome: `extract-meetings: skipped ${basename(note)} (status ${String(fm.data.status)})`, artifacts: [], durationMs: 0, acted: false },
      now(),
    );
    if ("error" in receipt) return receipt.error;
    return { json: { ...skipJson, receipt: receipt.receipt }, code: 0 };
  }

  // ── the canon + the note's own signals ──────────────────────────────────
  const canon = loadMeetingCanon(join(meetingsRoot, "registry"));
  const body = raw.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  const notesRoot = join(meetingsRoot, "notes");
  const { series } = scanMeetingSeries(notesRoot);
  const eventId = typeof fm.data.event_id === "string" ? fm.data.event_id : basename(note);
  const seriesKey = meetingSeriesKey(eventId);
  const seriesNoteNames = series.get(seriesKey) ?? [];
  const priorSeries = seriesNoteNames.filter((n) => n !== basename(note));
  const hasTranscript = existsSync(join(dirname(note), `${basename(note).replace(/\.md$/, "")}.transcript.md`));

  const proposal = proposeMeetingTags(fm.data, body, canon, { seriesNoteCount: seriesNoteNames.length });
  const steps = parseNextSteps(body);
  const meeting: MeetingRef = {
    basename: basename(note),
    relPath: relative(meetingsRoot, note).split("\\").join("/"),
    title: typeof fm.data.title === "string" ? fm.data.title : basename(note),
    date: typeof fm.data.date === "string" ? fm.data.date : "",
    eventId,
  };
  const links = proposeContextLinks({
    noteBasename: meeting.basename,
    hasTranscript,
    priorSeries,
    hopperBasenames: steps.map((_, i) => hopperBasename({ meeting, stepIndex: i })),
  });

  const anyTag = (Object.values(proposal.tags) as string[][]).some((values) => values.length > 0);
  const noteChanged = anyTag || links.lines.length > 0;
  const acted = noteChanged || steps.length > 0;
  const outcome =
    `extract-meetings: proposed tags for ${basename(note)} ` +
    `(products ${proposal.tags.products.length}, projects ${proposal.tags.projects.length}, entities ${proposal.tags.entities.length}, ` +
    `types ${proposal.tags.types.length}, themes ${proposal.tags.themes.length}), ${proposal.gaps.length} named gaps, ` +
    `proposed ${steps.length} hopper item(s)`;

  const json: Record<string, unknown> = {
    ...base,
    dry_run: !apply,
    status: "pending-tag",
    series: { key: seriesKey, notes: seriesNoteNames.length },
    tags: proposal.tags,
    unresolved: proposal.unresolved,
    gaps: proposal.gaps,
    canon_missing: canon.missing,
    steps: steps.length,
    next_steps: steps,
    context_links: links.lines,
    note_would_change: noteChanged,
  };

  // dry-run is REPORT-ONLY: no writes, no receipt (the distill convention)
  if (!apply) {
    return {
      json: {
        ...json,
        would_write: {
          note: noteChanged ? join(outRoot, "meetings", meeting.basename) : null,
          hopper: steps.map((_, i) => join(outRoot, "hopper", hopperBasename({ meeting, stepIndex: i }))),
        },
        receipt: { filed: false, reason: "dry-run (report-only)" },
      },
      code: 0,
    };
  }

  // ── apply: proposals land (the meeting vault itself stays untouched) ─────
  const startedAt = Date.now();
  const artifacts: string[] = [];
  if (noteChanged) {
    const target = join(outRoot, "meetings", meeting.basename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteMeetingNote(raw, proposal, links.lines));
    artifacts.push(target);
  }
  const hopperWritten: string[] = [];
  steps.forEach((step, i) => {
    const name = hopperBasename({ meeting, stepIndex: i });
    const target = join(outRoot, "hopper", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderHopperProposal({ meeting, step, stepIndex: i, totalSteps: steps.length }));
    hopperWritten.push(target);
    artifacts.push(target);
  });

  const receipt = triageJobReceipt(
    EXTRACT_MEETINGS_JOB,
    EXTRACT_MEETINGS_JOB,
    registry,
    dashboards,
    { outcome, artifacts, durationMs: Date.now() - startedAt, acted },
    now(),
  );
  if ("error" in receipt) return receipt.error;
  return {
    json: { ...json, wrote: { note: noteChanged ? artifacts[0] : null, hopper: hopperWritten }, receipt: receipt.receipt },
    code: 0,
  };
}
