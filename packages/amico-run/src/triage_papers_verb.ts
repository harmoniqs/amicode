// triage_papers_verb.ts — `amico triage-papers` (amicode #1686, brain flywheel
// slice 7 — the arjev intake half): the weekly notturno job that turns
// relevance-high papers from the personal vault's papers/ intake into
// hypothesis-seed proposals against the affected problem cards.
//
// THE MATCH (AC 3): EXACT platform identity — a problem card's `platform`
// appears in the paper's `systems`. No aliases, no fuzzy bridging (a germanium
// paper matches no spin card until a human says they're the same). A paper
// with no matching card yields NO seed — a named no-match outcome, exit 0.
//
// THE SEED (claim-shaped, per the issue): frontmatter EXACTLY the claim object
// (validateClaim green by construction — the #1681 ONE contract), evidence a
// paper/ pointer that resolves under the vault's papers/ tree (the claims lint
// resolves it — POINTER_KINDS carries the kind), and the affected problem
// cards linked as vault wikilinks + named in the claim's tags. Triage
// proposes, humans dispose: confidence is `low` (machinery links, it cannot
// calibrate a scientific prior), status is `unverified`, and stating the
// testable hypothesis stays a human act.
//
// ONE SUBSTRATE: the papers intake is read READ-ONLY; the problem cards are
// read READ-ONLY. --apply writes ONLY seeds, to a --out the caller names
// (default: the personal mount's claims candidates area — the claim layer's
// intake, where distill's candidates already live).
//
// IDEMPOTENCY (AC 4): deterministic naming (the paper's own basename) +
// deterministic bytes (dates from the paper, never the clock) — re-runs
// overwrite their own seeds and move nothing.
//
// THE RECEIPT (AC 4): the distill chassis gates verbatim (deny-list, job
// membership — unknown id exits 2, record-mode self-filter for acted jobs
// that seeded nothing). Dry-run by default: no writes, no receipt.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateClaim } from "@amicode/schema";
import { personalMount, resolveMountStack } from "./mounts.js";
import {
  TRIAGE_PAPERS_JOB,
  loadProblemCards,
  matchProblemCards,
  parsePaperNote,
  renderHypothesisSeed,
  triageDenyGate,
  triageJobReceipt,
  type TriagePaper,
} from "./triage.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico triage-papers [<paper.md>] [--papers <dir>] [--problems <dir>] [--out <dir>]",
  "                    [--registry <p>] [--dashboards <dir|file>] [--deny-list <p>] [--apply]",
  "",
  "  A relevance-high paper from the intake yields a claim-shaped hypothesis-seed",
  "  proposal (evidence-pointer to the paper) against the problem cards whose platform",
  "  matches the paper's systems. Dry-run by default; --apply writes the seeds to --out",
  "  (default: the personal mount's amicode/claims/candidates/). No matching card →",
  "  no seed, named honestly. Idempotent: deterministic naming + bytes.",
].join("\n");

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: TRIAGE_PAPERS_JOB, error, usage: USAGE, ...extra }, code: 64 };
}

/** A flag's value, or undefined. */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function triagePapersVerb(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => Date } = {},
): Promise<VerbResult> {
  const now = deps.now ?? (() => new Date());
  const valuedFlags = ["--papers", "--problems", "--out", "--registry", "--dashboards", "--deny-list"];
  let paper: string | undefined;
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
      if (a === "--registry") registry = argv[i + 1];
      else if (a === "--dashboards") dashboards = argv[i + 1];
      else if (a === "--deny-list") denyList = argv[i + 1];
      i++;
      continue;
    }
    if (paper === undefined && !a.startsWith("--")) {
      paper = a;
      continue;
    }
    return fail(`unexpected argument "${a}"`);
  }
  if (registry !== undefined && dashboards === undefined) return fail("the pass receipt needs its journal: --registry requires --dashboards <dir|file>");

  const mount = personalMount(resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML));
  const papersDir = flagValue(argv, "--papers") ?? (mount !== undefined ? join(mount.path, "papers") : undefined);
  if (papersDir === undefined) return fail("no papers intake resolved — pass --papers <dir> explicitly (the intake is never a guess)");
  const problemsDir = flagValue(argv, "--problems") ?? (mount !== undefined ? join(mount.path, "amicode", "problems") : undefined);
  if (problemsDir === undefined) return fail("no problems dir resolved — pass --problems <dir> explicitly (the problem cards are never a guess)");
  const outDir = flagValue(argv, "--out") ?? (mount !== undefined ? join(mount.path, "amicode", "claims", "candidates") : undefined);
  if (outDir === undefined) return fail("no personal vault mount resolved — pass --out <dir> explicitly (the seed area is never a guess)");

  if (paper === undefined && !existsSync(papersDir)) return fail(`papers intake not found: ${papersDir} (pass --papers <dir>)`);
  if (paper !== undefined && !existsSync(paper)) return fail(`paper note not found: ${paper}`);
  if (!existsSync(problemsDir)) return fail(`problems dir not found: ${problemsDir} (pass --problems <dir>)`);

  // the chassis deny gate fires BEFORE any vault work (org config is never read)
  if (registry !== undefined) {
    const denied = triageDenyGate(TRIAGE_PAPERS_JOB, registry, denyList);
    if (denied !== undefined) return denied;
  }

  // ── the worklist: one named paper, or the relevance-high notes of the intake ──
  const worklist: { file: string }[] = [];
  let scanned = 0;
  const skipped: string[] = [];
  if (paper !== undefined) {
    worklist.push({ file: paper });
    scanned = 1;
  } else {
    const files = readdirSync(papersDir).filter((f) => f.endsWith(".md")).sort();
    scanned = files.length;
    for (const f of files) worklist.push({ file: join(papersDir, f) });
  }

  const { cards, skipped: cardSkips } = loadProblemCards(problemsDir);
  skipped.push(...cardSkips);

  const seeds: { paper: string; matched: string[] }[] = [];
  const noMatch: { paper: string; systems: string[] }[] = [];
  const rendered: { paper: TriagePaper; text: string; basename: string }[] = [];
  let high = 0;
  let namedNote: string | undefined; // a named-paper run that yields nothing names WHY
  for (const { file } of worklist) {
    const parsed = parsePaperNote(readFileSync(file, "utf8"), file);
    if (!parsed.ok) {
      skipped.push(`${basename(file)}: ${parsed.error}`);
      if (paper !== undefined) namedNote = skipped[skipped.length - 1]!;
      continue;
    }
    if (parsed.paper.relevance !== "high") {
      skipped.push(`${basename(file)}: relevance ${JSON.stringify(parsed.paper.relevance)} — the weekly pass reads only relevance-high papers`);
      if (paper !== undefined) namedNote = skipped[skipped.length - 1]!;
      continue;
    }
    high++;
    const matched = matchProblemCards(parsed.paper, cards);
    if (matched.length === 0) {
      noMatch.push({ paper: basename(file), systems: parsed.paper.systems });
      if (paper !== undefined) namedNote = `no problem card matches the paper's systems (${parsed.paper.systems.join(", ")})`;
      continue;
    }
    const seed = renderHypothesisSeed(parsed.paper, matched);
    const v = validateClaim(seed.claim);
    if (!v.ok) return fail(`seed for ${basename(file)} failed the claim contract (a bug, not a paper problem): ${v.errors.join("; ")}`);
    seeds.push({ paper: basename(file), matched: matched.map((c) => c.slug) });
    rendered.push({ paper: parsed.paper, text: seed.text, basename: seed.basename });
  }

  const base = {
    verb: TRIAGE_PAPERS_JOB,
    ok: true,
    dry_run: !apply,
    papers_dir: papersDir,
    problems_dir: problemsDir,
    scanned,
    high,
    seeds,
    no_match: noMatch,
    skipped,
    ...(namedNote !== undefined ? { note: namedNote } : {}),
  };
  const seedPaths = rendered.map((r) => join(outDir, r.basename));

  // dry-run is REPORT-ONLY: no writes, no receipt (the distill convention)
  if (!apply) {
    return {
      json: {
        ...base,
        would_write: { seed: seedPaths[0] ?? null, seeds: seedPaths },
        receipt: { filed: false, reason: "dry-run (report-only)" },
      },
      code: 0,
    };
  }

  // ── apply: the seeds file into the claim layer's candidates area ──────────
  const startedAt = Date.now();
  mkdirSync(outDir, { recursive: true });
  const wrote: string[] = [];
  for (const r of rendered) {
    const target = join(outDir, r.basename);
    writeFileSync(target, r.text);
    wrote.push(target);
  }
  const outcome = `triage-papers: scanned ${scanned} papers (high ${high}), seeded ${rendered.length}, no-match ${noMatch.length}, skipped ${skipped.length}`;
  const receipt = triageJobReceipt(
    TRIAGE_PAPERS_JOB,
    TRIAGE_PAPERS_JOB,
    registry,
    dashboards,
    { outcome, artifacts: wrote, durationMs: Date.now() - startedAt, acted: rendered.length > 0 },
    now(),
  );
  if ("error" in receipt) return receipt.error;
  return { json: { ...base, wrote, receipt: receipt.receipt }, code: 0 };
}
