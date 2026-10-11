// triage.ts — the pure core behind `amico extract-meetings` + `amico
// triage-papers` (amicode #1686, brain flywheel slice 7 — the two dormant
// intakes). The meeting vault's tagging layer never ran (57/60 notes
// pending-tag, Context Links never fire) and the arjev paper intake
// accumulates without triage; this slice wires both into the claim layer's
// conventions (#1680/#1681 landed the substrate).
//
// DOCTRINE (#1679 + #1686's key decision): the meeting vault's OWN registry
// (RULES.md, meeting-types.md, products.md, internal-projects.md) is the
// schema of record — no second tagging scheme is invented here. TAGGING
// HONESTY: this is an LLM-adjacent pipeline — every proposal is generated
// from the note's own content (title, attendees, body), and where the canon's
// closed vocabulary has no fit the proposal NAMES THE GAP rather than
// inventing tags. Triage proposes, humans dispose: the meeting vault itself
// is a read-only substrate here — outputs are proposal notes written to a
// --out the caller names.
//
// IDEMPOTENCY: deterministic naming + deterministic bytes (no clock in the
// rendered outputs — dates come from the source note / paper). A re-run
// overwrites its own proposals with identical bytes and moves nothing (the
// distill re-distill doctrine).
//
// PURITY: reads via explicit paths only; no clock (dates derive from the
// inputs); every renderer is deterministic. The receipt chassis is the one
// effectful seam, parameterized like distill's (deny gate, job membership,
// record-mode self-filter, notturno_passes append).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { validate } from "@amicode/schema";
import { parseFrontmatter } from "./frontmatter.js";
import { appendSection, renderPass } from "./notturno_passes.js";
import { deniedBy, discoverDenyList, loadDenyList, loadRegistry } from "./notturno_registry.js";
import type { VerbResult } from "./verbs.js";

/** The two jobs' notturno registry ids — the receipt's membership check keys on
 *  these (the spec's job-registry names, never a second vocabulary). */
export const EXTRACT_MEETINGS_JOB = "extract-meetings";
export const TRIAGE_PAPERS_JOB = "triage-papers";

// ── the evidence-pointer kinds this slice files into the claim layer ──────────

/** A paper pointer: the note's basename under the vault's `papers/` tree
 *  (the literature intake — the seed's evidence). Resolves iff that file
 *  exists; the claims lint checks it (POINTER_KINDS carries the kind). */
export function paperPointer(paperBasename: string): string {
  return `paper/${paperBasename}`;
}

/** A meeting-note pointer: the note's path relative to the meeting vault
 *  root (the meeting intake — hopper-proposal provenance). */
export function meetingNotePointer(noteRelPath: string): string {
  return `meeting-note/${noteRelPath}`;
}

// ── the meeting canon (the vault's own registry, read not redefined) ──────────

/** The tier-1 vocabularies as the vault's registry defines them.
 *  `projects` is null iff internal-projects.md is absent — a tier with NO
 *  closed vocabulary on this machine, which every proposal names instead of
 *  inventing values. `missing` lists the registry files RULES.md references
 *  that are absent (the honest canon-health surface). */
export interface MeetingCanon {
  types: string[];
  products: string[];
  projects: string[] | null;
  missing: string[];
}

/** Parse one registry canon file's bullet list (the enumerated values). */
function parseCanonList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.match(/^-\s+(.*)$/)?.[1] ?? "")
    .map((v) => v.replace(/\*\*/g, "").replace(/`/g, "").trim())
    .filter((v) => v !== "");
}

/** Load the meeting canon from the vault's registry dir. Missing vocabulary
 *  files degrade to empty lists + named missing entries — never a guess. */
export function loadMeetingCanon(registryDir: string): MeetingCanon {
  const missing: string[] = [];
  const read = (file: string): string[] => {
    const p = join(registryDir, file);
    if (!existsSync(p)) {
      missing.push(file);
      return [];
    }
    return parseCanonList(readFileSync(p, "utf8"));
  };
  read("RULES.md"); // the canon's own rules — presence-checked, content is prose
  const types = read("meeting-types.md");
  const products = read("products.md");
  const projectsPath = join(registryDir, "internal-projects.md");
  const projects = existsSync(projectsPath) ? parseCanonList(readFileSync(projectsPath, "utf8")) : null;
  if (projects === null) missing.push("internal-projects.md");
  return { types, products, projects, missing };
}

/** The recurring-series identity: the calendar event id minus the timestamp
 *  suffix Gemini's ingest appends (…_YYYYMMDDTHHMMSSZ; out-of-band notes may
 *  carry only the date). Notes sharing the key are the same series. */
export function meetingSeriesKey(eventId: string): string {
  return eventId.replace(/_\d{8}(T\d{6}Z?)?$/, "");
}

// ── the tag proposal — content-derived, canon-closed, gaps named ─────────────

export interface MeetingTagProposal {
  tags: {
    products: string[];
    projects: string[];
    entities: string[];
    types: string[];
    themes: string[];
  };
  /** the canon's own ambiguity mechanism — carried through unchanged; this
   *  pipeline mints nothing ambiguous. */
  unresolved: string[];
  /** named honesty gaps: a tier with no content-derived fit, or a canon file
   *  absent. Each names its tier so the human triager sees the hole. */
  gaps: string[];
}

/** The closed type signals — each maps a note's own words to a canon
 *  meeting-type. Title-only for the strong series words (a body saying
 *  "debrief" describes one, a title being one is one); phrases for the rest. */
const TYPE_SIGNALS: [type: string, where: "title" | "text", pattern: RegExp][] = [
  ["debrief", "title", /\bdebrief\b/i],
  ["standup", "title", /\bstandup\b/i],
  ["test", "title", /\btest[- ]meeting\b/i],
  ["one-on-one", "title", /\bone[- ]on[- ]one\b|\b1:1\b/i],
  ["investor", "title", /\b(raise|investors?)\b/i],
  ["design-review", "text", /\bdesign review\b/i],
  ["strategy", "title", /\b(strategy|okr|roadmap|planning)\b/i],
];

/** Tier-3 themes are FREE-FORM kebab-case (the canon's rule) — a closed
 *  signal set over the note's own soft topics keeps them mechanical. */
const THEME_SIGNALS: [theme: string, pattern: RegExp][] = [
  ["hiring", /\bhiring\b|\bhire an?\b/i],
  ["pricing", /\bpricing\b|\bprice\b/i],
  ["latency", /\blatency\b/i],
  ["calibration", /\bcalibration\b/i],
  ["error-correction", /\berror correction\b|\berror-correcting\b/i],
  ["autonomous-research", /\bautonomous research\b|\bauto-research\b/i],
];

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive canon matching over the note's own text (the
 *  de-garbled text the canon's rules demand). Returns the canon's order. */
function matchClosedVocabulary(text: string, canon: string[]): string[] {
  return canon.filter((v) => new RegExp(`\\b${escapeRe(v)}\\b`, "i").test(text));
}

/** The tier-2 entity mint: persons from the note's OWN attendee canonicals
 *  (`[[kebab-canonical]]` — the vault's idiom, unambiguous), partners from an
 *  explicit partnership/collaboration phrase (the note's own words carry the
 *  namespace). Everything else is left un-minted — never a guessed entity. */
function proposeEntities(fm: Record<string, unknown>, body: string): string[] {
  const entities: string[] = [];
  const attendees = Array.isArray(fm.attendees) ? fm.attendees : [];
  for (const a of attendees) {
    if (typeof a !== "string") continue;
    const m = a.match(/^\[\[([a-z0-9-]+)\]\]$/); // the vault's own canonical form
    if (m !== null && !entities.includes(`person:${m[1]}`)) entities.push(`person:${m[1]}`);
  }
  for (const m of body.matchAll(/\b(?:partnership|collaboration) with ((?:[A-Z][\w'&.]*)(?:(?:,| and) (?:[A-Z][\w'&.]*))*)/g)) {
    const canonical = kebab(m[1]!);
    const tagged = `partner:${canonical}`;
    if (canonical !== "" && !entities.includes(tagged)) entities.push(tagged);
  }
  return entities;
}

/** Propose a pending-tag meeting note's three tag tiers from its own content.
 *  Every tier either carries content-derived canon-closed values or names its
 *  gap in `gaps` — a tier is never invented past its closed vocabulary. */
export function proposeMeetingTags(
  fm: Record<string, unknown>,
  body: string,
  canon: MeetingCanon,
  opts: { seriesNoteCount: number },
): MeetingTagProposal {
  const title = typeof fm.title === "string" ? fm.title : "";
  const text = `${title}\n${body}`;
  const gaps: string[] = [];

  // tier-1 types — the strongest signal is the title; external first
  // occurrences fall back to external-intro; recurring externals are a NAMED
  // gap (the closed set has no sync type — never stretch external-intro).
  const types = TYPE_SIGNALS.filter(([, where, pattern]) => (where === "title" ? title : text).match(pattern) !== null)
    .map(([type]) => type)
    .filter((type) => canon.types.includes(type) || (gaps.push(`types: signal "${type}" is outside this registry's meeting-types.md`), false));
  if (types.length === 0) {
    if (fm.external === true && canon.types.includes("external-intro") && opts.seriesNoteCount <= 1) {
      types.push("external-intro"); // external: true, first of its series — the note's own frontmatter
    } else if (fm.external === true) {
      gaps.push("types: recurring external series — the closed set has no external-sync type (external-intro covers first intros only)");
    } else if (canon.types.length > 0) {
      gaps.push("types: no closed type fits the note's own title/body signals — named, never invented");
    } else {
      gaps.push("types: registry/meeting-types.md absent — no closed vocabulary to apply");
    }
  }

  // tier-1 products / projects — canon files only, whole-word, canon order
  const products = matchClosedVocabulary(text, canon.products);
  if (products.length === 0) {
    gaps.push(canon.products.length === 0 ? "products: registry/products.md absent — no closed vocabulary to apply" : "products: no canon product named in the note's own text");
  }
  const projects = canon.projects === null ? [] : matchClosedVocabulary(text, canon.projects);
  if (canon.projects === null) {
    gaps.push("projects: registry/internal-projects.md not found — the projects tier has no closed vocabulary on this machine; values are never invented");
  } else if (projects.length === 0) {
    gaps.push("projects: no canon internal project named in the note's own text");
  }

  // tier-3 themes — free-form (the canon's rule), mechanical signal set
  const themes = THEME_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([theme]) => theme);

  return {
    tags: { products, projects, entities: proposeEntities(fm, body), types, themes },
    unresolved: [], // no ambiguity is minted: attendees are canonicals, partners carry their phrase
    gaps,
  };
}

/** Walk a meeting vault's notes tree (read-only): every note's series key
 *  (from its own event_id) → the basenames carrying it. Transcript siblings
 *  and notes without an event_id are excluded — never a guessed series. */
export function scanMeetingSeries(notesRoot: string): { series: Map<string, string[]>; noSeries: string[] } {
  const series = new Map<string, string[]>();
  const noSeries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".md") || entry.name.endsWith(".transcript.md")) continue;
      const fm = parseFrontmatter(readFileSync(join(dir, entry.name), "utf8"));
      if (!fm.ok || typeof fm.data.event_id !== "string") {
        noSeries.push(entry.name);
        continue;
      }
      const key = meetingSeriesKey(fm.data.event_id);
      const bucket = series.get(key) ?? [];
      bucket.push(entry.name);
      series.set(key, bucket);
    }
  };
  try {
    walk(notesRoot);
  } catch {
    /* unreadable notes tree → no series */
  }
  return { series, noSeries };
}

// ── the next-steps → hopper proposals (AC 2) ─────────────────────────────────

export interface NextStep {
  /** the step's owner as the note names them; null when the checkbox carries no bracket owner */
  owner: string | null;
  text: string;
}

/** The note's own next-steps checkbox list (the Gemini section), owner and
 *  action verbatim — machinery invents neither. Owner brackets may be escaped
 *  (`\[Jack Champagne\]`, the ingest's markdown) or bare; a checkbox without
 *  an owner is still proposed, unowned. */
export function parseNextSteps(body: string): NextStep[] {
  const start = body.match(/^### Next steps\s*$/m);
  if (start === null || start.index === undefined) return [];
  const after = body.slice(start.index + start[0].length);
  const end = after.search(/^### /m);
  const section = end === -1 ? after : after.slice(0, end);
  const steps: NextStep[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^-\s*\[ \]\s*(.*)$/);
    if (m === null) continue;
    const rest = m[1]!.trim();
    const owner = rest.match(/^\\\[(.+?)\\\]\s*/) ?? rest.match(/^\[(.+?)\]\s*/);
    if (owner !== null) {
      steps.push({ owner: owner[1]!.trim(), text: rest.slice(owner[0].length).trim() });
      continue;
    }
    steps.push({ owner: null, text: rest });
  }
  return steps;
}

/** One meeting note's identity, as the hopper proposal and the context links
 *  cite it (the vault's own fields, never derived). */
export interface MeetingRef {
  basename: string;
  /** path relative to the meeting vault root — the provenance pointer */
  relPath: string;
  title: string;
  date: string;
  eventId: string;
}

/** The hopper proposal's deterministic basename: meeting date + title slug +
 *  series id + zero-padded step. Same note + same step → same name, so a
 *  re-run overwrites its own proposal (idempotent by construction). */
export function hopperBasename(opts: { meeting: MeetingRef; stepIndex: number }): string {
  const slug = kebab(opts.meeting.title).slice(0, 40).replace(/-+$/, "");
  const series = meetingSeriesKey(opts.meeting.eventId).slice(0, 8);
  return `hopper-${opts.meeting.date.replace(/-/g, "")}-${slug}-${series}-${String(opts.stepIndex + 1).padStart(2, "0")}.md`;
}

/** Render one hopper proposal note: the vault's hopper shape, carrying the
 *  MEETING provenance (a resolvable meeting-note pointer + the wikilink) and
 *  the step's own text. Deterministic bytes — no clock, dates from the note. */
export function renderHopperProposal(opts: {
  meeting: MeetingRef;
  step: NextStep;
  stepIndex: number;
  totalSteps: number;
}): string {
  const { meeting, step } = opts;
  const fm = [
    "---",
    "type: hopper",
    `date: ${meeting.date}`,
    "status: proposed",
    `source: ${EXTRACT_MEETINGS_JOB}`,
    `meeting: "[[${meeting.basename.replace(/\.md$/, "")}]]"`,
    `provenance: ${meetingNotePointer(meeting.relPath)}`,
    `event_id: ${meeting.eventId}`,
    `step: ${opts.stepIndex + 1}/${opts.totalSteps}`,
    step.owner === null ? "owner: null" : `owner: "${step.owner}"`,
    "tags: [hopper, meeting-triage]",
    "---",
  ].join("\n");
  const body = [
    "",
    `# ${step.text}`,
    "",
    `From the meeting "${meeting.title}" (${meeting.date}) — next step ${opts.stepIndex + 1} of ${opts.totalSteps}` +
      (step.owner === null ? ", unowned in the note" : `, owner ${step.owner}`) +
      ".",
    "",
    "Proposed by `amico extract-meetings` (amicode #1686, the brain-flywheel meeting",
    `triage) from the meeting note's own Next-steps section (${meetingNotePointer(meeting.relPath)}).`,
    "Triage proposes, humans dispose.",
    "",
  ].join("\n");
  return fm + "\n" + body;
}

// ── the context-links section (AC 1) ─────────────────────────────────────────

/** Proposed context links: each line is an Obsidian wikilink whose target this
 *  pass can vouch for — the note's transcript sibling, the other sessions of
 *  the same recurring series, and this pass's own hopper proposals (resolvable
 *  by construction once applied). `targets` carries the basenames. */
export function proposeContextLinks(opts: {
  noteBasename: string;
  hasTranscript: boolean;
  priorSeries: string[];
  hopperBasenames: string[];
}): { lines: string[]; targets: string[] } {
  const lines: string[] = [];
  const targets: string[] = [];
  if (opts.hasTranscript) {
    lines.push(`- [[${opts.noteBasename.replace(/\.md$/, "")}.transcript]] — full de-garbled transcript`);
    targets.push(`${opts.noteBasename.replace(/\.md$/, "")}.transcript.md`);
  }
  for (const prior of [...opts.priorSeries].sort()) {
    lines.push(`- [[${prior.replace(/\.md$/, "")}]] — earlier session of this series`);
    targets.push(prior);
  }
  for (const hopper of opts.hopperBasenames) {
    lines.push(`- [[${hopper.replace(/\.md$/, "")}]] — next-step proposal (this pass)`);
    targets.push(hopper);
  }
  return { lines, targets };
}

// ── the note rewrite — surgical, prose untouched, deterministic ──────────────

/** Render a tag list in the ingest's own arr() shape (["a", "b"] / []). */
function tagArr(values: string[]): string {
  return `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

/** Rewrite one pending-tag meeting note proposal: the tag tiers populated (the
 *  vault's own frontmatter line shapes), the status flipped per the vault's
 *  own convention (tags applied → complete), and the context-links placeholder
 *  replaced with resolvable links. The prose body is preserved VERBATIM —
 *  machinery never edits prose. Deterministic bytes; throws honestly when the
 *  note does not carry the vault's own shapes (never a guessed rewrite). */
export function rewriteMeetingNote(raw: string, proposal: MeetingTagProposal, contextLinkLines: string[]): string {
  const block = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (block === null) throw new Error("malformed meeting note: could not isolate the frontmatter block");
  let fm = block[0];

  const tiers: [key: string, values: string[]][] = [
    ["products", proposal.tags.products],
    ["projects", proposal.tags.projects],
    ["entities", proposal.tags.entities],
    ["types", proposal.tags.types],
    ["themes", proposal.tags.themes],
  ];
  for (const [key, values] of tiers) {
    const line = new RegExp(`^(\\s*)${key}: \\[[^\\]]*\\]\\s*$`, "m").exec(fm);
    if (line === null) throw new Error(`malformed meeting note: no \`${key}: […]\` line in the frontmatter`);
    fm = fm.replace(line[0], `${line[1]}${key}: ${tagArr(values)}`);
  }
  const unresolved = /^(unresolved): \[[^\]]*\]\s*$/m.exec(fm);
  if (unresolved === null) throw new Error("malformed meeting note: no `unresolved: […]` line in the frontmatter");
  fm = fm.replace(unresolved[0], `unresolved: ${tagArr(proposal.unresolved)}`);

  // the vault's own convention (run.py): tags applied → status complete
  const anyTag = tiers.some(([, values]) => values.length > 0);
  if (anyTag) {
    if (!/^status: pending-tag\s*$/m.test(fm)) throw new Error("malformed meeting note: expected `status: pending-tag`");
    fm = fm.replace(/^status: pending-tag\s*$/m, "status: complete");
  }

  let out = raw.replace(block[0], fm);
  if (contextLinkLines.length > 0) {
    if (!out.includes("- (auto-linked at curation)")) {
      throw new Error("malformed meeting note: no `## Context Links` placeholder to replace — never a guessed insertion");
    }
    out = out.replace("- (auto-linked at curation)", contextLinkLines.join("\n"));
  }
  return out;
}

// ── the papers intake (AC 3) ──────────────────────────────────────────────────

export interface TriagePaper {
  file: string;
  basename: string;
  frontmatter: Record<string, unknown>;
  title: string;
  arxiv?: string;
  systems: string[];
  relevance?: string;
  dateRead: string;
}

/** Parse one intake paper through the library-paper contract (the #405
 *  frontmatter contract — the ONE paper record). A note without a resolvable
 *  identity (arxiv or doi) or that fails the contract is a NAMED error,
 *  never a triaged guess. */
export function parsePaperNote(raw: string, file: string): { ok: true; paper: TriagePaper } | { ok: false; error: string } {
  const fm = parseFrontmatter(raw);
  if (!fm.ok) return { ok: false, error: fm.error };
  if ((fm.data.arxiv === undefined || fm.data.arxiv === null) && (fm.data.doi === undefined || fm.data.doi === null)) {
    return { ok: false, error: "no identity: neither arxiv nor doi is set (the library-paper contract requires one)" };
  }
  const v = validate(fm.data, "library-paper");
  if (!v.ok) return { ok: false, error: `not a library-paper record: ${v.errors.join("; ")}` };
  const dateRead = fm.data.date_read ?? fm.data.date;
  if (typeof dateRead !== "string" || dateRead.trim() === "") {
    return { ok: false, error: "no date_read (or date) — the seed's provenance date is never invented" };
  }
  return {
    ok: true,
    paper: {
      file,
      basename: basename(file),
      frontmatter: fm.data,
      title: fm.data.title as string,
      arxiv: typeof fm.data.arxiv === "string" ? fm.data.arxiv : undefined,
      systems: Array.isArray(fm.data.systems) ? (fm.data.systems as string[]) : [],
      relevance: typeof fm.data.relevance === "string" ? fm.data.relevance : undefined,
      dateRead,
    },
  };
}

export interface ProblemCard {
  file: string;
  basename: string;
  slug: string;
  platform: string;
  problemKind: string;
  target: string;
  status: string;
}

/** Load the problem cards (the amicode problem-card frontmatter contract).
 *  A note that is not a problem card is a named skip, never a guess. */
export function loadProblemCards(dir: string): { cards: ProblemCard[]; skipped: string[] } {
  const cards: ProblemCard[] = [];
  const skipped: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return { cards, skipped: [`cannot read problems dir ${dir}`] };
  }
  for (const f of files.sort()) {
    const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
    if (!fm.ok) {
      skipped.push(`${f}: ${fm.error}`);
      continue;
    }
    if (fm.data.type !== "amicode-problem" || typeof fm.data.slug !== "string" || typeof fm.data.platform !== "string") {
      skipped.push(`${f}: not an amicode-problem card (missing type/slug/platform)`);
      continue;
    }
    cards.push({
      file: join(dir, f),
      basename: f,
      slug: fm.data.slug,
      platform: fm.data.platform,
      problemKind: typeof fm.data.problem_kind === "string" ? fm.data.problem_kind : "",
      target: typeof fm.data.target === "string" ? fm.data.target : "",
      status: typeof fm.data.status === "string" ? fm.data.status : "",
    });
  }
  return { cards, skipped };
}

/** The paper→card match: EXACT platform identity (a card's platform appears in
 *  the paper's `systems`). No aliases, no fuzzy bridging — a germanium paper
 *  matches no spin card until a human says they're the same. */
export function matchProblemCards(paper: TriagePaper, cards: ProblemCard[]): ProblemCard[] {
  return cards.filter((c) => paper.systems.includes(c.platform)).sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

/** Render the hypothesis-seed note: frontmatter EXACTLY the claim object (the
 *  ONE contract — validateClaim green by construction), body carrying the
 *  paper + affected problem cards as resolvable vault wikilinks. Deterministic
 *  bytes: dates come from the paper, never the clock. */
export function renderHypothesisSeed(paper: TriagePaper, matched: ProblemCard[]): { basename: string; claim: Record<string, unknown>; text: string } {
  const platforms = [...new Set(matched.map((c) => c.platform))].sort();
  const slugs = matched.map((c) => c.slug);
  const statement =
    `The high-relevance paper "${paper.title}" bears on ${slugs.length === 1 ? "problem card" : "problem cards"} ` +
    `${slugs.join(", ")} (${platforms.join(" + ")}): extract its testable implication into a hypothesis for those cards.`;
  const claim: Record<string, unknown> = {
    type: "hypothesis",
    statement,
    status: "unverified",
    confidence: "low", // machinery links, it cannot calibrate a scientific prior
    evidence: [paperPointer(paper.basename)],
    applied: 0,
    last_applied: null,
    history: [
      {
        date: `${paper.dateRead}T00:00:00.000Z`,
        event: "created",
        note: `seeded from the papers intake by amico ${TRIAGE_PAPERS_JOB} (amicode #1686): relevance high, systems (${paper.systems.join(", ")}) match problem cards (${slugs.join(", ")})`,
      },
    ],
    scope: "personal",
    tags: ["paper-triage", "hypothesis-seed", ...platforms, ...slugs],
  };
  const body = [
    "",
    `# ${statement}`,
    "",
    "Hypothesis seed — the weekly `triage-papers` pass (amicode #1686, the brain-flywheel",
    "slice 7) proposed this claim from the papers intake. Triage proposes, humans dispose:",
    "the seed carries the link; stating the testable hypothesis is a human act.",
    "",
    `- Paper: [[${paper.basename.replace(/\.md$/, "")}]] — "${paper.title}"${paper.arxiv !== undefined ? ` (arXiv:${paper.arxiv})` : ""}, relevance high, read ${paper.dateRead}`,
    "- Affected problem card(s):",
    ...matched.map((c) => `  - [[${c.slug}]] — ${c.platform} · ${c.problemKind} · target ${c.target} (${c.status})`),
    `- Evidence: ${paperPointer(paper.basename)} resolves under the personal vault's papers/ tree.`,
    "",
    "Promote into the claims registry (amicode/claims/) once the hypothesis is stated in",
    "testable form — this seed passes validateClaim verbatim.",
    "",
  ].join("\n");
  return { basename: paper.basename, claim, text: `---\n${stringifyYaml(claim, { lineWidth: 0 }).trimEnd()}\n---\n${body}` };
}

// ── the notturno receipt chassis (the distill verb's gates, shared) ───────────

/** The instance deny gate: a registry named by a deny row is org config — the
 *  public verb refuses to run it, pointing at the private instance's runner. */
export function triageDenyGate(verb: string, registry: string, denyList: string | undefined): VerbResult | undefined {
  const manifest = denyList ?? discoverDenyList(registry);
  if (manifest === undefined) return undefined;
  const loaded = loadDenyList(manifest);
  if (!loaded.ok) return { json: { verb, ok: false, error: loaded.error }, code: 2 };
  const row = deniedBy(registry, loaded.deny);
  if (row === undefined) return undefined;
  return {
    json: {
      verb,
      ok: false,
      error: "registry is instance config — denied by the instance deny list",
      registry,
      deny: row,
      hint: "this registry is deny-listed instance data — run the job through the private instance's runner (automation/notturno) in the amicissimo checkout; the public amico CLI never runs org config",
    },
    code: 64,
  };
}

/** The receipt step every terminal path shares: no registry → honestly not
 *  filed; else membership check (unknown job = data error 2), the record-mode
 *  self-filter (acted + nothing proposed → skipped), then the append. */
export function triageJobReceipt(
  verb: string,
  job: string,
  registry: string | undefined,
  dashboards: string | undefined,
  pass: { outcome: string; artifacts: string[]; durationMs: number; acted: boolean },
  now: Date,
): { receipt: Record<string, unknown> } | { error: VerbResult } {
  if (registry === undefined) return { receipt: { filed: false, reason: "no --registry" } };
  const loaded = loadRegistry(registry);
  if (!loaded.ok) return { error: { json: { verb, ok: false, error: loaded.error }, code: 2 } };
  const entry = loaded.registry.jobs.find((j) => j.id === job);
  if (entry === undefined) {
    return {
      error: {
        json: { verb, ok: false, error: `passes: unknown job '${job}' — not in the Notturno registry`, registry },
        code: 2,
      },
    };
  }
  if (entry.record === "acted" && !pass.acted) {
    return { receipt: { filed: false, skipped: true, reason: `passes: ${entry.id} records on action only; no action this run — skipped` } };
  }
  const target = appendSection(
    dashboards!,
    renderPass({
      job: entry.id,
      status: "ok",
      outcome: pass.outcome,
      duration_s: Math.round(pass.durationMs / 1000),
      artifacts: pass.artifacts,
      when: now,
    }),
  );
  return { receipt: { filed: true, job: entry.id, target } };
}
