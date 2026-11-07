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
//   stamp — the adoption verb (#1683, slice 4): an ACCEPTED recommend-outcome
//   or a solve-run citation moves the cited claim's `applied` counter +
//   `last_applied` and appends ONE `applied` history entry. Dry-run by
//   default; --apply writes. The citation must RESOLVE into the substrate
//   (the event exists in the problem's events.jsonl and IS accepted; the run
//   dir exists) before anything moves. Re-stamping the same citation is a
//   stamped:false no-op — adoption is a counter + a date, never a judgment.
//
//   sweep — the nightly backfill (#1683): walk every problem workspace's
//   events.jsonl (the ONE machine-readable adoption record that exists today
//   — the recommendation events amicode_recommend appends) and stamp every
//   claim its ACCEPTED outcomes adopted, via the propose events' provenance
//   refs (resolved mechanically against the registry). Overridden outcomes
//   never stamp; unmatched refs are named skips. Idempotent: the citation is
//   the idempotency key (each stamp's history note carries it), so a re-sweep
//   changes nothing. No new event format is invented — the sweep reads the
//   records that ARE persisted; a solve-run citation has no machine-readable
//   stream yet and rides the stamp verb (the honest seam).
//
//   promote / prune / synthesize (#1685, slice 6 — the dream curation motions
//   as weekly notturno jobs) live in curation_verb.ts and route from here:
//   promote PROPOSES one PR-body bundle per vault (10-cap, human-merged,
//   never auto-merged); prune reuses the lint as its schema-check (findings
//   are drift, exit 1) and applies only unambiguous frontmatter fixes;
//   synthesize writes hopper proposals from cross-claim tag clusters, never
//   strategy. Each files its pass receipt on the distill chassis
//   (--jobs + --dashboards, deny-list-gated, membership-checked).
//
// ONE SUBSTRATE (the distill doctrine): the chat DB is opened READ-ONLY;
// the vault is read for resolution; this verb never writes anywhere but the
// claims registry (or a --out the caller named). No personal mount and no
// explicit target → refuse (never guess a vault).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseMemoryCard, projectMemoryCard, renderClaimNote, lintClaimsRegistry, claimFileBasename, loadRegistryClaims, renderIndexView, parseClaimNote, renderStampedNote, stampAdoption, STAMP_SOURCES, planAdoptionSweep, type AdoptionCitation } from "./claims.js";
import { runLifecyclePass, renderQueueFile, rewriteClaimNote, DECAY_WINDOW_DAYS, type ContradictionSignal } from "./lifecycle.js";
import { promoteSub, pruneSub, synthesizeSub } from "./curation_verb.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import { validateClaim, CLAIM_TYPES, type ClaimType } from "@amicode/schema";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico claims project <card.md> [--out <dir>] [--type <insight|hypothesis|best-practice|hazard|method>] [--apply]",
  "amico claims lint [--registry <dir>] [--vault <mount root>] [--db <chat.db>]",
  "amico claims render [--registry <dir>] [--out <MEMORY.md>] [--cap-per-type <n>] [--apply]",
  "amico claims stamp <claim.md> --via <recommend-outcome|solve-run> --ref <citation> [--detail <text>] [--registry <dir>] [--apply]",
  "amico claims sweep [--registry <dir>] [--problems <dir>] [--apply]",
  "amico claims lifecycle [--registry <dir>] [--signals <contradictions.jsonl>]",
  "                       [--corroborate-threshold <n>] [--merge-threshold <f>] [--decay-days <n>]",
  "                       [--queue <file>] [--apply]",
  "amico claims promote [--registry <dir>] [--state <p>] [--out <bundles dir>] [--from <vault>]",
  "                     [--tier <team|public>] [--to <mount>] [--vault <root>]",
  "                     [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "amico claims prune [--registry <dir>] [--vault <root>] [--db <chat.db>]",
  "                   [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "amico claims synthesize [--registry <dir>] [--hopper <dir>]",
  "                        [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "",
  "  project — mechanically convert a memory card into a registry claim",
  "  (all fields preserved, provenance intact). Dry-run by default; --apply writes.",
  "  lint — validate every claim in the registry against the claim contract and",
  "  resolve every evidence pointer. Findings exit 1.",
  "  render — regenerate the hot-layer memory index (amicode/memory/MEMORY.md) as",
  "  a ranked view of the claims registry. Dry-run by default; --apply writes.",
  "  stamp — record one adoption: an accepted recommend-outcome (ref <slug>/<event-seq>)",
  "  or a solve-run citation (ref <run dir>) moves the cited claim's applied counter.",
  "  Dry-run by default; --apply writes.",
  "  sweep — the nightly backfill: stamp every claim its problems' recommend-outcome",
  "  events (events.jsonl) adopted. Idempotent: re-sweep changes nothing.",
  "  lifecycle — the nightly dedupe-merge + status-transition + decay pass",
  "  (#1684). Merges same-claim pairs onto the older claim, corroborates at the",
  "  evidence threshold, refutes on contradicted-by-run signals, and proposes",
  "  decayed claims for review (the queue never acts). Dry-run by default;",
  "  --apply rewrites survivor frontmatter (prose untouched), archives",
  "  duplicates under archive/, and writes the queue. Findings exit 1.",
  "  promote — the weekly proposal bundle (#1685): scope-team live claims → ONE",
  "  PR body + copies per vault, capped at 10 (overflow carries). PROPOSES ONLY —",
  "  a human merges; the verb never opens a PR. Dry-run by default; --apply",
  "  writes the bundle + the promote state stamp + the pass receipt. --tier",
  "  public (#1688) targets the kind: public mount with the SAME machinery:",
  "  the pool is scope-public claims, the two-note visibility split is checked",
  "  at promotion time (private-mechanism evidence / mechanism links refuse",
  "  BY NAME), and the bundle adds INDEX.md, the public vault's generated index.",
  "  prune — the weekly schema-check + hygiene pass (#1685): the claims lint's",
  "  findings are DRIFT (flagged, exit 1); only unambiguous frontmatter fixes",
  "  are applied. The retired /dream prune's semantics, on cadence.",
  "  synthesize — the weekly pattern pass (#1685): cross-claim tag clusters",
  "  (3+ data points) → hopper proposals. Proposes to the hopper only, never",
  "  to strategy. The retired /dream synthesize's destination, on cadence.",
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
  if (sub === "stamp") return stampSub(rest, env, now);
  if (sub === "sweep") return sweepSub(rest, env, now);
  if (sub === "lifecycle") return lifecycleSub(rest, env, now);
  if (sub === "promote") return promoteSub(rest, env, now);
  if (sub === "prune") return pruneSub(rest, env, now);
  if (sub === "synthesize") return synthesizeSub(rest, env, now);
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
  const valuedFlags = ["--registry", "--vault", "--db", "--meetings"];
  let registry: string | undefined;
  let vault: string | undefined;
  let db: string | undefined;
  let meetings: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!valuedFlags.includes(a)) return fail(`unknown flag "${a}"`);
    if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
    if (a === "--registry") registry = rest[i + 1];
    else if (a === "--vault") vault = rest[i + 1];
    else if (a === "--db") db = rest[i + 1];
    else meetings = rest[i + 1];
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

  const r = lintClaimsRegistry(dir, { vaultRoot: vaultRoot, db, meetingsRoot: meetings });
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

// ── claims stamp — the adoption verb (#1683, slice 4: the feedback loop closes) ──

/** The problems root (the extension's problemsDir seam: $AMICODE_PROBLEMS_DIR
 *  overrides — the hermetic test point). */
function problemsRoot(env: NodeJS.ProcessEnv): string {
  const v = env.AMICODE_PROBLEMS_DIR;
  return v && v.trim() !== "" ? v : join(homedir(), ".amico", "problems");
}

/** Read one problem's events.jsonl (read-only). Malformed lines are NAMED
 *  skips, never crashes — a broken event stream must not take the stamp down. */
function readEvents(file: string): { events: Record<string, unknown>[]; malformed: number } {
  const events: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function stampSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const valuedFlags = ["--via", "--ref", "--detail", "--registry"];
  let claim: string | undefined;
  let via: string | undefined;
  let ref: string | undefined;
  let detail: string | undefined;
  let registry: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (valuedFlags.includes(a)) {
      if (rest[i + 1] === undefined) return fail(`flag "${a}" needs a value`);
      if (a === "--via") via = rest[i + 1];
      else if (a === "--ref") ref = rest[i + 1];
      else if (a === "--detail") detail = rest[i + 1];
      else registry = rest[i + 1];
      i++;
      continue;
    }
    if (claim === undefined && !a.startsWith("--")) {
      claim = a;
      continue;
    }
    return fail(`unexpected argument "${a}"`);
  }
  if (claim === undefined) return fail("stamp needs a claim: amico claims stamp <claim.md> --via <kind> --ref <citation>");
  if (via === undefined) return fail(`stamp needs --via <(${STAMP_SOURCES.join("|")}> and --ref <citation>`);
  if (ref === undefined) return fail(`stamp needs --ref <citation> (a <problem-slug>/<event-seq> for a recommend-outcome, a run dir for a solve-run)`);
  if (!(STAMP_SOURCES as readonly string[]).includes(via)) {
    return fail(`--via must be one of (${STAMP_SOURCES.join(", ")}), got "${via}"`);
  }

  const m = mount(env);
  const dir = registry ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (dir === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  const file = claim.includes("/") ? claim : join(dir, claim);
  if (!existsSync(file)) return fail(`claim note not found: ${file} (the stamp target is never a guess)`);

  // the citation must RESOLVE into the substrate (the #1679 doctrine) before
  // anything moves: a recommend-outcome event must EXIST and BE accepted;
  // a solve-run dir must EXIST.
  let citation: AdoptionCitation;
  if (via === "recommend-outcome") {
    const slash = ref.lastIndexOf("/");
    const slug = slash === -1 ? "" : ref.slice(0, slash);
    const seq = slash === -1 ? Number.NaN : Number(ref.slice(slash + 1));
    if (slug === "" || !Number.isInteger(seq) || seq < 1)
      return fail(`--ref for a recommend-outcome is <problem-slug>/<event-seq>, got "${ref}"`);
    const eventsFile = join(problemsRoot(env), slug, "events.jsonl");
    if (!existsSync(eventsFile))
      return fail(`citation does not resolve: no events.jsonl for problem "${slug}" under ${problemsRoot(env)}`);
    const { events } = readEvents(eventsFile);
    const event = events.find((e) => e.seq === seq && e.entity === "recommendation");
    if (event === undefined) return fail(`citation does not resolve: no recommendation event ${seq} in ${slug}/events.jsonl`);
    const diff = (event.diff ?? {}) as { outcome?: unknown };
    if (diff.outcome !== "accepted")
      return fail(
        `refused: recommendation event ${slug}/${seq} carries outcome ${JSON.stringify(diff.outcome ?? null)} — adoption stamps only ACCEPTED outcomes (an override is a human declining, not a use)`,
      );
    citation = { kind: "recommend-outcome", ref, detail };
  } else {
    if (!existsSync(ref)) return fail(`citation does not resolve: no run dir at ${ref}`);
    citation = { kind: "solve-run", ref: basename(ref), detail };
  }

  const raw = readFileSync(file, "utf8");
  const parsed = parseClaimNote(raw);
  if (!parsed.ok) return fail(`${file}: ${parsed.error}`);
  const v = validateClaim(parsed.claim);
  if (!v.ok) return fail(`${file}: not a valid claim (${v.errors.join("; ")}) — the stamp never touches a broken note (the lint stays the registry's gate)`);

  const stamped = stampAdoption(parsed.claim, citation, now().toISOString());
  const json: Record<string, unknown> = {
    verb: "claims",
    ok: true,
    subcommand: "stamp",
    dry_run: !apply,
    claim: file,
    stamped: stamped.stamped,
    applied: (stamped.claim.applied as number),
    citation: `${citation.kind} ${citation.ref}`,
    ...(!stamped.stamped ? { note: "citation already carried in the applied trail — nothing moved (idempotent)" } : {}),
  };
  if (!apply) return { json: { ...json, would_write: file }, code: 0 };
  if (!stamped.stamped) return { json, code: 0 }; // idempotent re-stamp: no byte moves
  const stampedValid = validateClaim(stamped.claim);
  if (!stampedValid.ok)
    return fail(`stamp produced an invalid claim (a bug, not a card problem): ${stampedValid.errors.join("; ")}`);
  writeFileSync(file, renderStampedNote(raw, stamped.claim));
  return { json: { ...json, wrote: file, last_applied: stamped.claim.last_applied }, code: 0 };
}

// ── claims sweep — the nightly adoption backfill (#1683, AC 4) ────────────────

function sweepSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const valuedFlags = ["--registry", "--problems"];
  let registry: string | undefined;
  let problems: string | undefined;
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
    else problems = rest[i + 1];
    i++;
  }

  const m = mount(env);
  const dir = registry ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (dir === undefined)
    return fail("no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)");
  if (!existsSync(dir))
    return fail(`claims registry not found: ${dir} (missing is a typo or nothing projected yet — nothing to sweep)`);
  const root = problems ?? problemsRoot(env);
  if (!existsSync(root))
    return fail(`problems root not found: ${root} (pass --problems <dir> — the sweep never guesses a substrate)`);

  const { claims, skipped } = loadRegistryClaims(dir);

  // read every problem's event stream — the ONE substrate this sweep touches, read-only
  const streams: { slug: string; events: Record<string, unknown>[] }[] = [];
  let malformed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const eventsFile = join(root, entry, "events.jsonl");
    if (!existsSync(eventsFile)) continue; // a problem with no events yet is a clean skip, not an error
    const read = readEvents(eventsFile);
    malformed += read.malformed;
    streams.push({ slug: entry, events: read.events });
  }

  const plan = planAdoptionSweep(streams, claims);
  const json: Record<string, unknown> = {
    verb: "claims",
    ok: true,
    subcommand: "sweep",
    dry_run: !apply,
    registry: dir,
    problems: root,
    would_stamp: apply ? undefined : plan.stamps.length,
    already: plan.already,
    scanned: plan.scanned,
    skipped_refs: plan.skippedRefs,
    overridden: plan.overridden,
    malformed,
    skipped_claims: skipped,
  };
  if (!apply) return { json, code: 0 };

  const changed: string[] = [];
  for (const { file, citation } of plan.stamps) {
    const path = join(dir, file);
    const raw = readFileSync(path, "utf8");
    const parsed = parseClaimNote(raw);
    if (!parsed.ok) continue; // named via skipped/skipped_refs surfaces — never a crash
    const stamped = stampAdoption(parsed.claim, citation, now().toISOString());
    if (!stamped.stamped) continue; // raced an identical citation — idempotent no-op
    const valid = validateClaim(stamped.claim);
    if (!valid.ok) return fail(`sweep produced an invalid claim for ${file} (a bug): ${valid.errors.join("; ")}`);
    writeFileSync(path, renderStampedNote(raw, stamped.claim));
    changed.push(file);
  }
  return { json: { ...json, stamped: changed.length, changed: [...new Set(changed)].sort() }, code: 0 };
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
