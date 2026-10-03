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
