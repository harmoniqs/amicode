// claims_verb.ts — `amico claims` (amicode #1681, brain flywheel slice 2 +
// #1682 slice 3): the claims registry's CLI surface. Three subcommands:
//
//   project — the mechanical memory-card → claim migration (the spec's
//   "47 memory cards project to claims mechanically"): dry-run by default
//   (render + validate, report-only); --apply writes the claim note into the
//   registry. Deterministic naming (the card's basename) makes re-projection
//   an overwrite, never a duplicate. Every projection passes validateClaim
//   BEFORE it is written — the registry only ever gains contract objects.
//
//   lint — the registry's gate: every claim validates against the ONE schema
//   (unknown types, missing required fields, stray keys), every evidence
//   pointer resolves into its substrate (the vault's amicode/memory/ subtree,
//   the chat DB read-only), and the #1679 invariant holds (zero evidence
//   cannot sit past unverified). Findings exit 1 — a lint that cannot fail
//   gates nothing.
//
//   render — the hot-layer index as a GENERATED view (#1682): amicode/memory/
//   MEMORY.md re-rendered from the registry, ranked by recency + adoption +
//   confidence, capped per claim type. Dry-run by default; --apply writes.
//   Idempotent by construction (same registry + same clock → same bytes);
//   hand-edits are regenerated away — claims are the source of truth, never
//   this file. A zero-live-claim registry is REFUSED, never silently blanking
//   the index.
//
//   lifecycle — the NIGHTLY pass (#1684): dedupe-merge (same-claim pairs
//   merge onto the older claim — evidence + trails accumulate), status
//   transitions through append-only history (corroborate at the evidence
//   threshold, refute on a contradicted-by-run signal from --signals), and
//   the decay review queue (a proposal surface next to the registry —
//   never an actor). Dry-run by default; --apply rewrites survivor notes
//   (frontmatter only, prose untouched), archives duplicates under
//   archive/, and writes the queue. Findings (unactable signals, refused
//   refutations) exit 1 — the pass is never silent.
//
// ONE SUBSTRATE (the distill doctrine): the chat DB is opened READ-ONLY;
// the vault is read for resolution; this verb never writes anywhere but the
// claims registry (or a --out the caller named). No personal mount and no
// explicit target → refuse (never guess a vault).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseMemoryCard, projectMemoryCard, renderClaimNote, lintClaimsRegistry, claimFileBasename, loadRegistryClaims, renderIndexView } from "./claims.js";
import { runLifecyclePass, renderQueueFile, rewriteClaimNote, DECAY_WINDOW_DAYS, type ContradictionSignal } from "./lifecycle.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import { validateClaim, CLAIM_TYPES, type ClaimType } from "@amicode/schema";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico claims project <card.md> [--out <dir>] [--type <insight|hypothesis|best-practice|hazard|method>] [--apply]",
  "amico claims lint [--registry <dir>] [--vault <mount root>] [--db <chat.db>]",
  "amico claims render [--registry <dir>] [--out <MEMORY.md>] [--cap-per-type <n>] [--apply]",
  "amico claims lifecycle [--registry <dir>] [--signals <contradictions.jsonl>]",
  "                       [--corroborate-threshold <n>] [--merge-threshold <f>] [--decay-days <n>]",
  "                       [--queue <file>] [--apply]",
  "",
  "  project — mechanically convert a memory card into a registry claim",
  "  (all fields preserved, provenance intact). Dry-run by default; --apply writes.",
  "  lint — validate every claim in the registry against the claim contract and",
  "  resolve every evidence pointer. Findings exit 1.",
  "  render — regenerate the hot-layer memory index (amicode/memory/MEMORY.md) as",
  "  a ranked view of the claims registry. Dry-run by default; --apply writes.",
  "  lifecycle — the nightly dedupe-merge + status-transition + decay pass",
  "  (#1684). Merges same-claim pairs onto the older claim, corroborates at the",
  "  evidence threshold, refutes on contradicted-by-run signals, and proposes",
  "  decayed claims for review (the queue never acts). Dry-run by default;",
  "  --apply rewrites survivor frontmatter (prose untouched), archives",
  "  duplicates under archive/, and writes the queue. Findings exit 1.",
].join("\n");

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "claims", error, usage: USAGE, ...extra }, code: 64 };
}

/** The personal mount for this invocation (env seam, hermetic tests). */
function mount(env: NodeJS.ProcessEnv) {
  return personalMount(resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML));
}

/** The claims verb. deps.now is the injectable clock (the distill seam shape). */
export async function claimsVerb(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => Date } = {},
): Promise<VerbResult> {
  const now = deps.now ?? (() => new Date());
  const [sub, ...rest] = argv;
  if (sub === "project") return projectSub(rest, env, now);
  if (sub === "lint") return lintSub(rest, env);
  if (sub === "render") return renderSub(rest, env, now);
  if (sub === "lifecycle") return lifecycleSub(rest, env, now);
  return fail(sub === undefined ? "no subcommand" : `unknown subcommand "${sub}"`);
}

// ── claims project ───────────────────────────────────────────────────────────

function projectSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {  const valuedFlags = ["--out", "--type"];
  let card: string | undefined;
  let out: string | undefined;
  let claimType: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (valuedFlags.includes(a)) {
      if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
      if (a === "--out") out = rest[i + 1];
      else claimType = rest[i + 1];
      i++;
      continue;
    }
    if (card === undefined && !a.startsWith("--")) {
      card = a;
      continue;
    }
    return fail(`unexpected argument "${a}"`);
  }
  if (card === undefined) return fail("project needs a memory card: amico claims project <card.md>");
  if (!existsSync(card)) return fail(`memory card not found: ${card}`);
  if (claimType !== undefined && !(CLAIM_TYPES as readonly string[]).includes(claimType)) {
    return fail(`--type must be one of (${CLAIM_TYPES.join(", ")}), got "${claimType}"`);
  }

  const m = mount(env);
  const registry = out ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (registry === undefined)
    return fail("no personal vault mount resolved — pass --out <dir> explicitly (the claims registry is never a guess)");

  // the mechanical projection — every refusal below is honest, never a guess
  const raw = readFileSync(card, "utf8");
  let claim;
  let parsedCard;
  try {
    parsedCard = parseMemoryCard(raw);
    claim = projectMemoryCard(parsedCard, {
      cardRel: basename(card),
      projectedAt: now().toISOString(),
      claimType: claimType as ClaimType | undefined,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const v = validateClaim(claim);
  if (!v.ok) return fail(`projection failed the claim contract (a bug, not a card problem): ${v.errors.join("; ")}`);

  const note = renderClaimNote(claim, parsedCard, basename(card));
  const target = join(registry, claimFileBasename(card));

  if (!apply) {
    return {
      json: { verb: "claims", ok: true, dry_run: true, valid: true, would_write: target, ...claim },
      code: 0,
    };
  }
  if (!existsSync(registry)) mkdirSync(registry, { recursive: true });
  writeFileSync(target, note);
  return { json: { verb: "claims", ok: true, dry_run: false, valid: true, wrote: target, ...claim }, code: 0 };
}

// ── claims lint ───────────────────────────────────────────────────────────────

function lintSub(rest: string[], env: NodeJS.ProcessEnv): VerbResult {
  const valuedFlags = ["--registry", "--vault", "--db"];
  let registry: string | undefined;
  let vault: string | undefined;
  let db: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!valuedFlags.includes(a)) return fail(`unknown flag "${a}"`);
    if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
    if (a === "--registry") registry = rest[i + 1];
    else if (a === "--vault") vault = rest[i + 1];
    else db = rest[i + 1];
    i++;
  }

  const m = mount(env);
  const defaultRegistry = m !== undefined ? join(m.path, "amicode", "claims") : undefined;
  const dir = registry ?? defaultRegistry;
  if (dir === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  if (!existsSync(dir))
    return fail(`claims registry not found: ${dir} (empty is fine — missing is a typo or nothing projected yet)`);
  const vaultRoot = vault ?? m?.path;

  const r = lintClaimsRegistry(dir, { vaultRoot, db });
  return {
    json: { verb: "claims", ok: r.ok, subcommand: "lint", registry: dir, files: r.files.length, findings: r.findings, clean: r.ok },
    code: r.ok ? 0 : 1,
  };
}

// ── claims render — the generated hot-layer index (#1682) ─────────────────────

function renderSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const valuedFlags = ["--registry", "--out", "--cap-per-type"];
  let registry: string | undefined;
  let out: string | undefined;
  let capPerType: number | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (!valuedFlags.includes(a)) return fail(`unknown flag "${a}"`);
    if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
    if (a === "--registry") registry = rest[i + 1];
    else if (a === "--out") out = rest[i + 1];
    else {
      const n = Number(rest[i + 1]);
      if (!Number.isInteger(n) || n < 1) return fail(`--cap-per-type must be a positive integer, got "${rest[i + 1]}"`);
      capPerType = n;
    }
    i++;
  }

  const m = mount(env);
  const dir = registry ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (dir === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  if (!existsSync(dir))
    return fail(`claims registry not found: ${dir} (missing is a typo or nothing projected yet — nothing to render)`);
  const target = out ?? (m !== undefined ? join(m.path, "amicode", "memory", "MEMORY.md") : undefined);
  if (target === undefined)
    return fail("no personal vault mount resolved — pass --out <MEMORY.md> explicitly (the index target is never a guess)");

  const { claims, skipped } = loadRegistryClaims(dir);
  const r = renderIndexView(claims, { now: now(), capPerType });
  if (r.ranked.length === 0)
    return fail(
      `no live claims to render — the hot-layer index is never an empty guess (excluded: [${r.excluded.join(", ")}]; skipped: [${skipped.join("; ")}] — project or distill first)`,
      { excluded: r.excluded, skipped },
    );

  const json = {
    verb: "claims",
    ok: true,
    subcommand: "render",
    dry_run: !apply,
    registry: dir,
    would_write: apply ? undefined : target,
    wrote: apply ? target : undefined,
    bullets: r.ranked.length,
    per_type: Object.fromEntries([...new Set(r.ranked.map((c) => c.claim.type))].map((t) => [t, r.ranked.filter((c) => c.claim.type === t).length])),
    excluded: r.excluded,
    capped: r.capped,
    skipped,
    rendered: r.text,
  };
  if (!apply) return { json, code: 0 };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, r.text);
  return { json, code: 0 };
}

// ── claims lifecycle — the nightly dedupe-merge + transitions + decay pass ────

/** Parse a --signals file (JSONL, one contradicted-by-run signal per line).
 *  Every malformed line becomes a NAMED finding — a signal is never guessed,
 *  never silently dropped. A missing file is the caller's error (exit 64). */
function loadSignals(file: string): { signals: ContradictionSignal[]; findings: string[] } | { error: string } {
  if (!existsSync(file)) return { error: `--signals file not found: ${file} (contradiction signals are explicit — never a guess)` };
  const signals: ContradictionSignal[] = [];
  const findings: string[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      const s = JSON.parse(line) as Record<string, unknown>;
      if (typeof s.claim !== "string" || s.claim === "" || typeof s.run !== "string" || s.run === "" || (s.note !== undefined && typeof s.note !== "string")) {
        findings.push(`signals line ${i + 1}: not a valid signal (expected {claim, run, note?} with non-empty string claim and run) — skipped`);
        continue;
      }
      signals.push({ claim: s.claim, run: s.run, note: s.note as string | undefined });
    } catch (e) {
      findings.push(`signals line ${i + 1}: not a valid signal — ${JSON.stringify(line.slice(0, 60))} (${e instanceof Error ? e.message : String(e)}) — skipped`);
    }
  }
  return { signals, findings };
}

function lifecycleSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const valuedFlags = ["--registry", "--signals", "--corroborate-threshold", "--merge-threshold", "--decay-days", "--queue"];
  let registry: string | undefined;
  let signalsPath: string | undefined;
  let corroborateThreshold: number | undefined;
  let mergeThreshold: number | undefined;
  let decayDays: number | undefined;
  let queue: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (!valuedFlags.includes(a)) return fail(`unknown flag "${a}"`);
    if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
    const v = rest[i + 1]!;
    if (a === "--registry") registry = v;
    else if (a === "--signals") signalsPath = v;
    else if (a === "--queue") queue = v;
    else if (a === "--corroborate-threshold" || a === "--decay-days") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) return fail(`flag "${a}" must be a positive integer, got "${v}"`);
      if (a === "--corroborate-threshold") corroborateThreshold = n;
      else decayDays = n;
    } else {
      const t = Number(v);
      if (!Number.isFinite(t) || t <= 0 || t > 1) return fail(`flag "--merge-threshold" must be a number in (0, 1], got "${v}"`);
      mergeThreshold = t;
    }
    i++;
  }

  const m = mount(env);
  const dir = registry ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (dir === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  if (!existsSync(dir))
    return fail(`claims registry not found: ${dir} (missing is a typo or nothing projected yet — nothing to metabolize)`);

  let signals: ContradictionSignal[] = [];
  let signalFindings: string[] = [];
  if (signalsPath !== undefined) {
    const loaded = loadSignals(signalsPath);
    if ("error" in loaded) return fail(loaded.error);
    signals = loaded.signals;
    signalFindings = loaded.findings;
  }

  const { claims, skipped } = loadRegistryClaims(dir);
  const r = runLifecyclePass(claims, {
    now: now(),
    signals,
    corroborateThreshold,
    mergeThreshold,
    decayWindowDays: decayDays,
  });
  const findings = [...signalFindings, ...r.findings];
  const queueFile = queue ?? join(dirname(dir), "review-queue.md");
  const windowDays = decayDays ?? DECAY_WINDOW_DAYS;
  const queueText = renderQueueFile(r.queue, { now: now(), windowDays });

  const json: Record<string, unknown> = {
    verb: "claims",
    ok: findings.length === 0,
    subcommand: "lifecycle",
    dry_run: !apply,
    registry: dir,
    queue_file: queueFile,
    signals: signals.length,
    scanned: claims.length,
    skipped,
    merges: r.merges,
    transitions: r.transitions,
    queue: r.queue,
    findings,
    queue_text: queueText,
  };
  if (!apply) return { json, code: findings.length > 0 ? 1 : 0 };

  // the write path: survivor frontmatter only (prose untouched), duplicates
  // archived beside the registry (never deleted outright — the vault
  // doctrine), the queue written at its home.
  const changed = new Set<string>([...r.merges.map((x) => x.survivor), ...r.transitions.map((t) => t.file)]);
  const after = new Map(r.claims.map((c) => [c.file, c.claim]));
  for (const file of changed) {
    const claim = after.get(file);
    if (claim === undefined) continue; // a transition on a file this pass also merged away — already handled by the merge
    writeFileSync(join(dir, file), rewriteClaimNote(readFileSync(join(dir, file), "utf8"), claim));
  }
  if (r.merges.length > 0) mkdirSync(join(dir, "archive"), { recursive: true });
  for (const dup of r.merges.map((x) => x.duplicate)) renameSync(join(dir, dup), join(dir, "archive", dup));
  mkdirSync(dirname(queueFile), { recursive: true });
  writeFileSync(queueFile, queueText);
  json.wrote = {
    survivors: [...changed],
    archived: r.merges.map((x) => `archive/${x.duplicate}`),
    queue_file: queueFile,
  };
  return { json, code: findings.length > 0 ? 1 : 0 };
}
