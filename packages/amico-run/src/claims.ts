// claims.ts — the pure core behind `amico claims` (amicode #1681, brain flywheel
// slice 2 — the ONE type namespace): the memory-card → claim projection, the
// claim-note rendering, and the registry lint's evidence resolution.
//
// DOCTRINE (#1679, the company-brain flywheel): notes are renderings —
// machinery operates on CLAIMS only. A registry claim note's frontmatter is
// EXACTLY the claim object (validated by the shared @amicode/schema
// validateClaim — the single contract, the pack.toml fixture discipline);
// provenance rides the evidence pointers + the append-only history, never a
// parallel key set. The projection extends slice 1's conventions rather than
// inventing any: the evidence-pointer vocabulary (`memory-card/…` joins
// distill's `chat-session/` / `chat-message/`), deterministic note naming
// (re-projection overwrites its own claim, the re-distill doctrine), prose
// never edited (the card's own body is preserved verbatim below the claim
// frontmatter), and the lifecycle start `unverified` — every transition after
// it is machinery's (slice 5), never the projection's.
//
// PURITY: no I/O except the lint's read-only substrate probes (explicit
// paths); no clock (projectedAt passed in); the renderer is deterministic.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { sqliteBatch } from "./sqlite_bridge.js";
import { parseFrontmatter } from "./frontmatter.js";
import { validateClaim, type ClaimType } from "@amicode/schema";

// ── the memory namespace (the OLD store this slice dissolves) ────────────────

/** The memory cards' own type vocabulary — the namespace that collided with
 *  the vault contract's. Fixed and closed: a card outside it is refused, never
 *  guessed into a claim. */
export const MEMORY_CARD_TYPES = ["feedback", "project", "reference", "insight"] as const;
export type MemoryCardType = (typeof MEMORY_CARD_TYPES)[number];

/** The mechanical card→claim type map (the migration default; the verb's
 *  --type overrides per card where the map's conservative choice is wrong):
 *  `insight` cards ARE insights; `feedback` cards are predominantly
 *  ways-of-working lessons (best-practice); `project` and `reference` cards
 *  carry durable findings about how things behave (insight — the safe
 *  catch-all the census's "~90% aligned" reading lands on). */
export const MEMORY_CARD_TO_CLAIM_TYPE: Record<MemoryCardType, ClaimType> = {
  insight: "insight",
  feedback: "best-practice",
  project: "insight",
  reference: "insight",
};

/** One parsed memory card: frontmatter fields + the prose body + the raw
 *  frontmatter block (preserved verbatim into the claim note). */
export interface MemoryCard {
  frontmatter: Record<string, unknown>;
  body: string;
  frontmatterBlock: string;
}

/** Parse a memory card (YAML frontmatter + prose body). Throws on malformed
 *  structure — the caller reports it honestly (a bad card is never a guessed
 *  claim). */
export function parseMemoryCard(raw: string): MemoryCard {
  const fm = parseFrontmatter(raw);
  if (!fm.ok) throw new Error(fm.error);
  const block = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (block === null) throw new Error("malformed memory card: could not isolate the frontmatter block");
  return {
    frontmatter: fm.data,
    body: raw.slice(block[0].length),
    frontmatterBlock: block[0].replace(/^---[ \t]*\r?\n/, "").replace(/\r?\n---[ \t]*(\r?\n|$)/, ""),
  };
}

// ── the evidence-pointer vocabulary (extends slice 1's) ───────────────────────

/** A memory-card pointer: the card's path under the vault's `amicode/memory/`
 *  subtree. Resolves iff that file exists — the lint checks it. */
export function memoryCardPointer(cardRel: string): string {
  return `memory-card/${cardRel}`;
}

/** The pointer kinds the lint can resolve — slice 1's chat vocabulary plus
 *  this slice's memory-card kind. An evidence pointer outside this vocabulary
 *  is flagged, never waved through. */
export const POINTER_KINDS = ["chat-session", "chat-message", "memory-card"] as const;

// ── the projection (AC 3) ─────────────────────────────────────────────────────

export interface ProjectCardOpts {
  /** the card's path relative to the vault's `amicode/memory/` — the pointer */
  cardRel: string;
  /** the projection instant (ISO) — the caller's clock, never this module's */
  projectedAt: string;
  /** per-card override of the mechanical type map (the verb's --type) */
  claimType?: ClaimType;
}

/** Project one memory card into its claim object — the mechanical migration.
 *  Refuses (throws, honestly) a card whose type is outside the memory
 *  namespace or whose description is absent (a statement is never invented).
 *  The result passes validateClaim by construction. */
export function projectMemoryCard(card: MemoryCard, opts: ProjectCardOpts) {
  const cardType = card.frontmatter.type;
  if (typeof cardType !== "string" || !(MEMORY_CARD_TYPES as readonly string[]).includes(cardType)) {
    throw new Error(
      `unknown memory-card type ${JSON.stringify(cardType)} (known: ${MEMORY_CARD_TYPES.join(", ")}) — refusing to guess a claim type`,
    );
  }
  const description = card.frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error("memory card carries no description — the claim statement is the card's description, never invented");
  }
  const tags = card.frontmatter.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === "string" && t.trim() !== ""))) {
    throw new Error("memory card tags must be a list of non-empty strings");
  }
  return {
    type: opts.claimType ?? MEMORY_CARD_TO_CLAIM_TYPE[cardType as MemoryCardType],
    statement: description.trim(),
    status: "unverified",
    confidence: "medium",
    evidence: [memoryCardPointer(opts.cardRel)],
    applied: 0,
    last_applied: null,
    history: [
      {
        date: opts.projectedAt,
        event: "projected",
        note: `projected from memory card ${opts.cardRel} (card type: ${cardType}) by amico claims project — the #1681 mechanical migration of the memory namespace into claims`,
      },
    ],
    scope: "personal",
    tags: Array.isArray(tags) ? (tags as string[]) : [],
  };
}

/** The claim note's basename — the CARD's basename, deterministically: a
 *  re-projection overwrites its own claim rather than piling duplicates into
 *  the registry (the distill re-distill doctrine). */
export function claimFileBasename(cardFile: string): string {
  return `${basename(cardFile).replace(/\.md$/, "")}.md`;
}

/** Render the claim note: frontmatter = EXACTLY the claim object (YAML,
 *  deterministic), body = the rendering + the original card preserved verbatim
 *  (frontmatter block as YAML + prose unfenced) — machinery never edits prose,
 *  and the claim stays self-contained if the card later archives. */
export function renderClaimNote(claim: unknown, card: MemoryCard, cardRel: string): string {
  const frontmatter = stringifyYaml(claim, { lineWidth: 0 }).trimEnd();
  const c = claim as { statement: string };
  return [
    "---",
    frontmatter,
    "---",
    "",
    `# ${c.statement}`,
    "",
    `Claim of the \`claims\` registry — projected from the memory card`,
    `\`amicode/memory/${cardRel}\` by \`amico claims project\` (amicode #1681).`,
    "The original card is preserved verbatim below; the claim object above is the",
    "machinery surface — its lifecycle (corroborate / supersede / refute) is stamped",
    "by the flywheel's passes, never by hand.",
    "",
    "## Original card — frontmatter (preserved verbatim)",
    "",
    "```yaml",
    card.frontmatterBlock.trimEnd(),
    "```",
    "",
    "## Original card — body (preserved verbatim)",
    "",
    card.body.replace(/^\r?\n/, ""),
    "",
  ].join("\n");
}

// ── the registry lint (AC 2) ─────────────────────────────────────────────────

/** The substrates evidence pointers resolve into: the vault root (memory-card
 *  pointers resolve under `<root>/amicode/memory/`) and the chat DB (slice 1's
 *  chat-session / chat-message pointers). Both optional; an absent substrate
 *  makes its pointers' unresolvability a FINDING, never a silent pass. */
export interface LintSubstrates {
  vaultRoot?: string;
  db?: string;
}

export interface ClaimLintResult {
  /** claim notes scanned (*.md at the registry top level; subdirs like
   *  candidates/ are not the registry proper) */
  files: string[];
  /** field-precise findings, each naming its file */
  findings: string[];
  ok: boolean;
}

/** Lint one evidence pointer. Returns undefined iff resolved; else the
 *  finding. Read-only substrates only. */
function lintPointer(pointer: string, substrates: LintSubstrates, db: { sessions: Set<string>; messages: Set<string> }): string | undefined {
  const slash = pointer.indexOf("/");
  const kind = slash === -1 ? "" : pointer.slice(0, slash);
  const id = slash === -1 ? "" : pointer.slice(slash + 1);
  if (id === "") return `malformed evidence pointer ${JSON.stringify(pointer)} (expected <kind>/<id>)`;
  if (kind === "memory-card") {
    if (substrates.vaultRoot === undefined) return `${pointer}: no vault substrate given — cannot resolve (pass --vault <mount root>)`;
    return existsSync(join(substrates.vaultRoot, "amicode", "memory", id)) ? undefined : `${pointer}: unresolved — no such memory card under ${join(substrates.vaultRoot, "amicode", "memory")}`;
  }
  if (kind === "chat-session") return db.sessions.has(id) ? undefined : `${pointer}: unresolved — no such session in the chat DB`;
  if (kind === "chat-message") return db.messages.has(id) ? undefined : `${pointer}: unresolved — no such message in the chat DB`;
  return `${pointer}: unknown pointer kind "${kind}" (known: ${POINTER_KINDS.join(", ")})`;
}

/** Load the chat-side ids (read-only) so each pointer is one set probe, not a
 *  query — the lint never writes a byte to the substrate. A missing DB yields
 *  empty sets (every chat pointer is then honestly flagged); an UNREADABLE DB
 *  (exists but not a chat DB) is a named error so the lint reports the broken
 *  substrate instead of crashing or silently waving pointers through. */
function loadChatIds(db: string | undefined): { sessions: Set<string>; messages: Set<string>; dbError?: string } {
  if (db === undefined || !existsSync(db)) return { sessions: new Set(), messages: new Set() };
  try {
    const batch = sqliteBatch(db, "ro", [
      { sql: "SELECT id FROM session" },
      { sql: "SELECT id FROM message" },
    ]);
    return {
      sessions: new Set(batch.results[0].rows.map((r) => String(r.id))),
      messages: new Set(batch.results[1].rows.map((r) => String(r.id))),
    };
  } catch (e) {
    return { sessions: new Set(), messages: new Set(), dbError: e instanceof Error ? e.message : String(e) };
  }
}

/** Lint the claims registry: every *.md's frontmatter must BE a valid claim
 *  (unknown types, missing required fields, stray keys — the ONE contract),
 *  every evidence pointer must resolve, and the parent invariant holds: a
 *  claim with zero evidence cannot sit at a corroborated-or-later status. */
export function lintClaimsRegistry(registryDir: string, substrates: LintSubstrates): ClaimLintResult {
  let files: string[] = [];
  try {
    files = readdirSync(registryDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return { files: [], findings: [`cannot read registry ${registryDir}`], ok: false };
  }

  const chatIds = loadChatIds(substrates.db);
  const findings: string[] = [];
  if (chatIds.dbError !== undefined) findings.push(`chat substrate unreadable: ${chatIds.dbError} — chat pointers are flagged, not waved through`);
  for (const file of files) {
    const raw = readFileSync(join(registryDir, file), "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm.ok) {
      findings.push(`${file}: ${fm.error}`);
      continue;
    }
    const claim = fm.data;
    const v = validateClaim(claim);
    for (const err of v.errors) findings.push(`${file}: ${err}`);
    if (!v.ok) continue;

    const evidence = claim.evidence as string[];
    for (const pointer of evidence) {
      const finding = lintPointer(pointer, substrates, chatIds);
      if (finding !== undefined) findings.push(`${file}: ${finding}`);
    }

    // the #1679 invariant, mechanically: zero evidence cannot reach corroborated
    const status = claim.status as string;
    if ((status === "corroborated" || status === "superseded" || status === "refuted") && evidence.length === 0) {
      findings.push(`${file}: status "${status}" with zero evidence — a claim with zero resolvable evidence cannot pass "unverified"`);
    }
  }
  return { files, findings, ok: findings.length === 0 };
}

/** Parse a claim note's frontmatter back into the claim object — the seam the
 *  later passes (index generation, lifecycle) read the registry through. */
export function parseClaimNote(raw: string): { ok: true; claim: Record<string, unknown> } | { ok: false; error: string } {
  const fm = parseFrontmatter(raw);
  if (!fm.ok) return { ok: false, error: fm.error };
  return { ok: true, claim: fm.data };
}

// ── the hot-layer index (amicode #1682, slice 3 — MEMORY.md becomes a view) ───
//
// The hand-maintained memory index is dissolved: the hot layer is a DERIVED
// rendering of the claims registry, ranked by recency + adoption + confidence
// and capped per claim type. The registry is the source of truth; this view
// is regenerated on every render and hand-edits are discarded by design. The
// consumer contract is the stack_state plugin's readIndexLines (bullet lines
// starting with "- ", capped at 50) — the output must stay parseable by that
// exact reader, so the provenance header lives in an HTML comment whose lines
// can never eat a bullet slot.
//
// PURITY: no I/O beyond the loader's registry read; no clock (now passed in);
// the renderer is deterministic — same claims + same clock → identical bytes.

/** The plugin reader's hard cap (packages/extension/opencode-plugin/
 *  stack_state.ts, the readIndexLines call site for MEMORY.md) — the view
 *  never emits more bullets than the reader takes. Pinned by test. */
export const INDEX_MAX_LINES = 50;

/** The default per-domain (per claim-type) cap: 5 types × 10 = the reader cap
 *  exactly — one type can never flood the hot layer. */
export const INDEX_DEFAULT_PER_TYPE = 10;

/** The equal-thirds composite's confidence axis (calibrated bands → [0,1]). */
const CONFIDENCE_FACTOR = { high: 1, medium: 0.6, low: 0.3 } as const;

/** Recency decay per the flywheel's "hot layer" intent: a claim's heat halves
 *  roughly monthly (days since its NEWEST history event). */
const RECENCY_HALFLIFE_DAYS = 30;

/** The hot statuses — superseded and refuted claims are replaced/refuted
 * knowledge; they stay out of the hot layer by design. Shared by the
 * curation jobs (#1685): the same live set feeds promote's eligibility and
 * synthesize's pattern economy. */
export const HOT_STATUSES = ["unverified", "corroborated"] as const;

/** One registry claim in renderable shape: its file name + its claim object. */
export interface RegistryClaim {
  file: string;
  claim: Record<string, unknown>;
}

/** Load the registry through the slice-2 seam: top-level *.md notes, parsed
 *  and validated against the ONE contract. A note that does not parse or does
 *  not validate is SKIPPED and NAMED (the render never crashes on a broken
 *  note, never waves one into the index) — the lint stays the registry's gate. */
export function loadRegistryClaims(registryDir: string): { claims: RegistryClaim[]; skipped: string[] } {
  const files = readdirSync(registryDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const claims: RegistryClaim[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const parsed = parseClaimNote(readFileSync(join(registryDir, file), "utf8"));
    if (!parsed.ok) {
      skipped.push(`${file}: ${parsed.error}`);
      continue;
    }
    const v = validateClaim(parsed.claim);
    if (!v.ok) {
      skipped.push(`${file}: ${v.errors.join("; ")}`);
      continue;
    }
    claims.push({ file, claim: parsed.claim });
  }
  return { claims, skipped };
}

/** The ranking score ∈ [0,3]: an equal-thirds composite of
 *   recency   exp(−ageDays/30) over the claim's newest history date,
 *   adoption  applied/(applied+1) — saturating, so one stamp matters and
 *             a hundred don't dominate,
 *   confidence high 1 / medium 0.6 / low 0.3.
 *  (The issue's "recency × adoption × confidence" is realized as the additive
 *  composite: a literal product zeroes every claim at applied=0 — the whole
 *  registry, until slice 4 stamps adoption — a degenerate day-one index.) */
export function claimScore(claim: Record<string, unknown>, now: Date): number {
  const history = Array.isArray(claim.history) ? claim.history : [];
  const dates = history
    .map((h) => Date.parse((h as { date?: unknown }).date as string))
    .filter((d) => Number.isFinite(d));
  const recency =
    dates.length === 0 ? 0 : Math.exp(-Math.max(0, (now.getTime() - Math.max(...dates)) / (86_400_000 * RECENCY_HALFLIFE_DAYS)));
  const applied = typeof claim.applied === "number" && claim.applied >= 0 ? claim.applied : 0;
  const confidence = CONFIDENCE_FACTOR[(claim.confidence as keyof typeof CONFIDENCE_FACTOR) ?? ""] ?? 0;
  return recency + applied / (applied + 1) + confidence;
}

/** The bullet label: the claim's statement, bracket-escaped for the markdown
 *  link and truncated to a one-line pointer. */
function bulletLabel(statement: string): string {
  const escaped = statement.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return escaped.length > 160 ? escaped.slice(0, 159) + "…" : escaped;
}

export interface IndexRender {
  /** the emitted claims, in ranked order (post-filter, post-caps) */
  ranked: RegistryClaim[];
  /** per-claim scores, parallel to ranked (transparency for the verb's json) */
  scores: number[];
  /** superseded/refuted claims kept out of the hot layer, named with status */
  excluded: string[];
  /** claims dropped by the per-domain or global caps, named */
  capped: string[];
  /** the rendered index — the exact bytes written to MEMORY.md */
  text: string;
}

/** Render the hot-layer index: filter to hot statuses, rank by the composite
 *  (tie → claim file, ascending, for stable re-renders), cap per claim type
 *  and globally, and emit the provenance header + one bullet per claim.
 *  Deterministic: same claims + same clock → identical bytes. */
export function renderIndexView(
  claims: RegistryClaim[],
  opts: { now: Date; capPerType?: number; maxLines?: number },
): IndexRender {
  const capPerType = opts.capPerType ?? INDEX_DEFAULT_PER_TYPE;
  const maxLines = opts.maxLines ?? INDEX_MAX_LINES;

  const excluded: string[] = [];
  const hot = claims.filter((c) => {
    const status = c.claim.status as string;
    if ((HOT_STATUSES as readonly string[]).includes(status)) return true;
    excluded.push(`${c.file} (${status})`);
    return false;
  });

  const scored = hot
    .map((c) => ({ entry: c, score: claimScore(c.claim, opts.now) }))
    .sort((a, b) => b.score - a.score || (a.entry.file < b.entry.file ? -1 : 1));

  const ranked: RegistryClaim[] = [];
  const scores: number[] = [];
  const capped: string[] = [];
  const perType = new Map<string, number>();
  for (const { entry, score } of scored) {
    const type = entry.claim.type as string;
    if (ranked.length >= maxLines || (perType.get(type) ?? 0) >= capPerType) {
      capped.push(entry.file);
      continue;
    }
    perType.set(type, (perType.get(type) ?? 0) + 1);
    ranked.push(entry);
    scores.push(score);
  }

  const header = [
    "<!--",
    "generated view — `amico claims render` (amicode #1682, the brain-flywheel hot-layer index)",
    "source of truth: the claims registry (amicode/claims/) — never this file. claims are the",
    "atomic unit; this index is a DERIVED rendering, ranked by recency + adoption + confidence",
    "and capped per claim type; superseded and refuted claims stay out of the hot layer.",
    "hand-edits are regenerated away by design — edit claims, not this view.",
    "-->",
  ];
  const bullets = ranked.map((c) => {
    const claim = c.claim;
    return `- [${bulletLabel(claim.statement as string)}](../claims/${c.file}) — ${claim.type} · ${claim.status} · ${claim.confidence} · applied ${claim.applied}×`;
  });
  return { ranked, scores, excluded, capped, text: [...header, "", ...bullets].join("\n") + "\n" };
}

// ── adoption stamping (amicode #1683, slice 4 — the feedback loop closes) ─────
//
// The last mile of the flywheel: knowledge USED must reach the card, or the
// index's adoption axis is dead. An accepted recommend-outcome or a citation
// in a solve run increments the claim's `applied` counter and sets
// `last_applied` — a counter + a date, NEVER a judgment: statement, status,
// confidence are untouched (lifecycle is slice 5's, a parallel concern).
//
// IDEMPOTENCY: the citation IS the key. Each stamp appends ONE history entry
// whose note carries the citation in a fixed convention
// (`applied via <kind> <ref>`), and a stamp whose citation already appears in
// the claim's applied trail is a no-op — the nightly sweep may re-read the
// same event streams forever and the registry never double-counts.
//
// PURITY: no I/O, no clock (stampedAt passed in); the stamp is a copy, the
// original claim object is never mutated.

/** The closed citation vocabulary — where an adoption event can come from. */
export const STAMP_SOURCES = ["recommend-outcome", "solve-run"] as const;
export type StampSourceKind = (typeof STAMP_SOURCES)[number];

/** One adoption citation: the kind of use + the machine-checkable ref that
 * identifies it (the problem slug + event seq for a recommend-outcome; the
 * run id for a solve-run citation). */
export interface AdoptionCitation {
  kind: StampSourceKind;
  ref: string;
  /** free-text context (which param, what value) — never load-bearing */
  detail?: string;
}

/** The applied history note for a citation — the ONE convention both the
 * stamper and the idempotency check read, so they can never diverge. */
export function appliedNote(citation: AdoptionCitation): string {
  return `applied via ${citation.kind} ${citation.ref}${citation.detail !== undefined ? ` — ${citation.detail}` : ""}`;
}

/** Whether a claim's applied trail already carries this exact citation —
 * the idempotency check. Exact-prefix against the note convention (with the
 * ` — ` separator guard, so ref "a" never matches ref "a-b"). */
export function isStamped(claim: Record<string, unknown>, citation: AdoptionCitation): boolean {
  const history = Array.isArray(claim.history) ? claim.history : [];
  const base = `applied via ${citation.kind} ${citation.ref}`;
  return history.some((h) => {
    const entry = h as { event?: unknown; note?: unknown };
    return entry.event === "applied" && typeof entry.note === "string" && (entry.note === base || entry.note.startsWith(`${base} — `));
  });
}

/** Stamp one adoption on a claim: applied +1, last_applied moved, ONE
 * `applied` history entry appended (the pinned vocabulary — no new event
 * class). Statement and status are never touched. An already-carried
 * citation is a stamped:false no-op (the sweep's re-reads change nothing). */
export function stampAdoption(
  claim: Record<string, unknown>,
  citation: AdoptionCitation,
  stampedAt: string,
): { stamped: boolean; claim: Record<string, unknown> } {
  if (isStamped(claim, citation)) return { stamped: false, claim };
  const applied = typeof claim.applied === "number" && claim.applied >= 0 ? claim.applied : 0;
  const history = Array.isArray(claim.history) ? claim.history : [];
  return {
    stamped: true,
    claim: {
      ...claim,
      applied: applied + 1,
      last_applied: stampedAt,
      history: [...history, { date: stampedAt, event: "applied", note: appliedNote(citation) }],
    },
  };
}

/** Re-render a stamped claim note: the frontmatter block is replaced by the
 * claim object (deterministic YAML), everything after it — the rendering +
 * the preserved card prose — survives VERBATIM. Machinery never edits
 * prose; the stamp only moves the claim object it owns. */
export function renderStampedNote(raw: string, claim: Record<string, unknown>): string {
  const block = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (block === null) throw new Error("malformed claim note: could not isolate the frontmatter block");
  return raw.replace(block[0], `---\n${stringifyYaml(claim, { lineWidth: 0 }).trimEnd()}\n---\n`);
}

// The SWEEP half (the nightly backfill): the recommend-outcome event stream —
// `<problem-workspace>/events.jsonl`, the records `amicode_recommend` appends
// (entity "recommendation", action proposed|outcome) — is the ONE machine-
// readable adoption record that exists today. An accepted outcome stamps the
// claims its recommendation's PROVENANCE REFS name; a ref is resolved
// MECHANICALLY (trailing path segment = a registry claim file, with or without
// .md — the projection names claims after their cards) and a ref matching no
// registry claim is a NAMED skip, never a guess. Overridden outcomes are
// named and never stamp. No new event format is invented — refs stay the
// free-form citations the propose events already carry; when a richer
// machine-readable citation surface lands, this resolver is the one seam.

/** Resolve one provenance ref against the registry: mechanical trailing-
 *  segment match (the projection names the claim note after its card, so
 *  `memory-card/x.md`, `claims/x.md`, and bare `x` all land on `x.md`).
 *  Anything else is a named skip — never a fuzzy guess. */
export function resolveClaimRef(ref: string, claims: RegistryClaim[]): RegistryClaim | undefined {
  const segment = ref.split("/").pop() ?? ref;
  return claims.find((c) => c.file === (segment.endsWith(".md") ? segment : `${segment}.md`));
}

export interface SweepStamp {
  file: string;
  citation: AdoptionCitation;
}

export interface AdoptionSweepPlan {
  /** citations to stamp, in stream order */
  stamps: SweepStamp[];
  /** citations already carried in their claim's applied trail (re-sweep no-ops) */
  already: number;
  /** accepted-outcome refs matching no registry claim, named with their event */
  skippedRefs: string[];
  /** overridden outcomes seen — named, never stamped */
  overridden: string[];
  /** recommendation events read across all streams */
  scanned: number;
}

/** The refs a proposed recommendation's provenance carries. */
function provenanceRefs(diff: Record<string, unknown>): string[] {
  const provenance = Array.isArray(diff.provenance) ? diff.provenance : [];
  return provenance
    .map((p) => (p as { ref?: unknown }).ref)
    .filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

/** Plan the adoption sweep over parsed event streams: for each problem, walk
 *  its events in order, pair each ACCEPTED outcome with the refs of its key's
 *  latest proposed event (a Veloce auto-accept carries outcome + provenance
 *  on the propose itself), resolve refs against the registry, and emit one
 *  stamp per (accepted event × distinct claim). Pure — the caller reads the
 *  streams and applies the plan. */
export function planAdoptionSweep(problems: { slug: string; events: unknown[] }[], claims: RegistryClaim[]): AdoptionSweepPlan {
  const plan: AdoptionSweepPlan = { stamps: [], already: 0, skippedRefs: [], overridden: [], scanned: 0 };
  const seen = new Set<string>(); // `${file}|${ref}` — dedupe stamps across the whole sweep? no, per event
  for (const { slug, events } of problems) {
    const proposed = new Map<string, string[]>(); // key → refs of its latest propose
    for (const raw of events) {
      const event = raw as { seq?: unknown; entity?: unknown; action?: unknown; diff?: unknown };
      if (event.entity !== "recommendation") continue; // only recommendation events carry adoption
      plan.scanned++;
      const diff = (event.diff ?? {}) as Record<string, unknown>;
      const seq = typeof event.seq === "number" ? event.seq : -1;
      const key = typeof diff.key === "string" ? diff.key : "?";
      const refs = provenanceRefs(diff);
      const isPropose = event.action === "proposed";
      const outcome = typeof diff.outcome === "string" ? diff.outcome : undefined;
      if (isPropose) proposed.set(key, refs);
      if (outcome === "overridden") {
        plan.overridden.push(`${slug}/${seq}`); // a human declining is named, never stamped
        continue;
      }
      if (outcome !== "accepted") continue;
      // an accepted outcome: stamp the claims its recommendation's refs name. A
      // Veloce auto-accept carries the outcome on the propose itself; a plain
      // outcome pairs with its key's latest propose.
      const pairRefs = isPropose ? refs : (proposed.get(key) ?? []);
      const stamped = new Set<string>();
      for (const ref of pairRefs) {
        const claim = resolveClaimRef(ref, claims);
        if (claim === undefined) {
          plan.skippedRefs.push(`${slug}/${seq}: provenance ref "${ref}" matches no registry claim`);
          continue;
        }
        if (stamped.has(claim.file)) continue; // one adoption per event, however the ref was phrased
        stamped.add(claim.file);
        const citation = { kind: "recommend-outcome", ref: `${slug}/${seq}` } as const;
        if (isStamped(claim.claim, citation) || seen.has(`${claim.file}|${citation.ref}`)) {
          plan.already++;
          continue;
        }
        seen.add(`${claim.file}|${citation.ref}`);
        plan.stamps.push({ file: claim.file, citation });
      }
    }
  }
  return plan;
}
