// claims_verb.ts — `amico claims` (amicode #1681, brain flywheel slice 2):
// the claims registry's CLI surface. Two subcommands:
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
// ONE SUBSTRATE (the distill doctrine): the chat DB is opened READ-ONLY;
// the vault is read for resolution; this verb never writes anywhere but the
// claims registry (or a --out the caller named). No personal mount and no
// explicit target → refuse (never guess a vault).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseMemoryCard, projectMemoryCard, renderClaimNote, lintClaimsRegistry, claimFileBasename } from "./claims.js";
import { personalMount, resolveMountStack } from "./mounts.js";
import { validateClaim, CLAIM_TYPES, type ClaimType } from "@amicode/schema";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico claims project <card.md> [--out <dir>] [--type <insight|hypothesis|best-practice|hazard|method>] [--apply]",
  "amico claims lint [--registry <dir>] [--vault <mount root>] [--db <chat.db>]",
  "",
  "  project — mechanically convert a memory card into a registry claim",
  "  (all fields preserved, provenance intact). Dry-run by default; --apply writes.",
  "  lint — validate every claim in the registry against the claim contract and",
  "  resolve every evidence pointer. Findings exit 1.",
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

  const defaultOut = mount(env) !== undefined ? join(mount(env)!.path, "amicode", "claims") : undefined;
  const registry = out ?? defaultOut;
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

// Bun/node readFile promise-free: cards are small; sync read is the verb norm.
function readFileRaw(p: string): string {
  // eslint-disable-next-line
  return readFileSyncUtf8(p);
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
  const vaultRoot = vault ?? m?.path;

  const r = lintClaimsRegistry(dir, { vaultRoot, db });
  const base = { verb: "claims", ok: r.ok, subcommand: "lint", registry: dir, files: r.files.length, findings: r.findings };
  if (r.findings.length === 0 && r.files.length === 0 && !existsSync(dir)) {
    return { json: { ...base, clean: true, note: "registry is empty (or does not exist)" }, code: 0 };
  }
  return { json: { ...base, clean: r.ok }, code: r.ok ? 0 : 1 };
}
