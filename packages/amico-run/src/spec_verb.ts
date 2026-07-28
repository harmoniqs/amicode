// packages/amico-run/src/spec_verb.ts — the `amico spec` verb (spec-20260728 §3).
//
//   amico spec review <spec-path> [--critics N] [--offline] [--json]
//   amico spec validate <spec-path>
//
// The path is POSITIONAL. `--spec` is taken by the launch path (`amico run --spec
// <solvespec.json>`, `amico resolve`), and reusing that flag for a different artifact
// invites the exact confusion the `design_hash`-not-`spec_hash` rename avoids.
//
// EXIT CODES, and why the verdict is ALSO a payload field: the MCP facade returns only
// `result.json` and discards `VerbResult.code`, and the deliberation skill that calls this
// verb runs in another runtime. An exit code alone would be invisible to it.
//
//   0  approved | approved-mechanical | degraded   (review is not the gate)
//   64 usage / config — the established ConfigError class
//   65 blocking findings: revise and re-run
//   66 round budget exhausted: a human decision point
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validate } from "@amicode/schema";
import { parseFrontmatter } from "./frontmatter.js";
import { precedentFor } from "./ledger_query.js";
import { reviewSpec, type ReviewOptions } from "./spec_review.js";
import type { VerbResult } from "./verbs.js";

/** The `precedent` lens's ledger channel. Named here rather than inlined so the verb's default
 *  and the test seam are visibly the same shape — the lens never reads the ledger itself. */
const defaultQueryLedger: NonNullable<ReviewOptions["queryLedger"]> = (structureHash) => precedentFor(structureHash);

const USAGE = "amico spec review <spec-path> [--critics N] [--offline] [--json]  |  amico spec validate <spec-path>";

function usageError(error: string): VerbResult {
  return { json: { verb: "spec", ok: false, error, usage: USAGE }, code: 64 };
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** Flags this verb accepts. Anything else is a usage error rather than being ignored:
 *  silently accepting `--spec <path>` would "work" and teach the caller a flag that
 *  belongs to the launch path, which is worse than refusing it. Typos fail loudly too. */
const KNOWN_FLAGS = new Set(["--critics", "--offline", "--json"]);
const VALUED_FLAGS = new Set(["--critics"]);

/** Validate EVERY flag, then return the first positional. Flags may precede or follow the path.
 *
 *  Scanning the WHOLE argv rather than returning at the first non-flag argument: the earlier
 *  version stopped at the path, so a TRAILING unknown flag (`spec review <path> --bogus`) was
 *  silently ignored — which is the failure the known-flag set exists to prevent, just moved one
 *  position to the right. Found while writing the same check for `plan`. */
function positional(argv: string[]): { path: string } | { error: string } {
  let path: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!KNOWN_FLAGS.has(name)) return { error: `unknown flag ${name}` };
      if (VALUED_FLAGS.has(name) && !a.includes("=")) i++; // consume its value
      continue;
    }
    if (path === undefined) path = a;
  }
  return path === undefined ? { error: "a spec path is required (positional, not --spec)" } : { path };
}

async function review(argv: string[], ctx: SpecVerbCtx): Promise<VerbResult> {
  const pos = positional(argv);
  if ("error" in pos) return usageError(pos.error);
  const abs = resolve(pos.path);
  if (!existsSync(abs)) return usageError(`spec not found: ${abs}`);

  const criticsRaw = flagValue(argv, "--critics");
  let critics: number | undefined;
  if (criticsRaw !== undefined) {
    critics = Number(criticsRaw);
    if (!Number.isInteger(critics) || critics < 0) return usageError(`--critics must be a non-negative integer, got "${criticsRaw}"`);
  }

  let r;
  try {
    r = await reviewSpec(abs, (ctx.readFile ?? readFileSync)(abs, "utf8") as string, {
      critics,
      offline: argv.includes("--offline"),
      spawnCritic: ctx.spawnCritic,
      queryLedger: ctx.queryLedger ?? defaultQueryLedger,
      round: ctx.round,
    });
  } catch (e) {
    // A sidecar that cannot be written, or an oversize record: loud, not a clean review.
    return { json: { verb: "spec", subcommand: "review", ok: false, error: (e as Error).message }, code: 64 };
  }

  return {
    json: {
      verb: "spec",
      subcommand: "review",
      ok: r.exit_code === 0,
      // The verdict rides the PAYLOAD as well as the exit code — the MCP facade discards
      // the code, and the skill that calls this verb lives in another runtime.
      review_verdict: r.review_verdict,
      exit_code: r.exit_code,
      spec_id: r.spec_id,
      design_hash: r.design_hash,
      rounds: r.rounds,
      lens_status: r.lens_status,
      critics: r.critics,
      findings_count: r.findings_count,
      blocking_count: r.blocking_count,
      findings_ref: r.findings_ref,
      // Blocking findings inline: the refusal must be actionable, so the caller gets the
      // shape of what to fix without a second read.
      blocking: r.findings.filter((f) => f.severity === "blocking"),
    },
    code: r.exit_code,
  };
}

/** `amico spec validate` — the frontmatter contract alone, for `lint_vault_contract.sh`
 *  to shell rather than reimplementing the check in bash. */
function validateOnly(argv: string[], ctx: SpecVerbCtx): VerbResult {
  const pos = positional(argv);
  if ("error" in pos) return usageError(pos.error);
  const abs = resolve(pos.path);
  if (!existsSync(abs)) return usageError(`spec not found: ${abs}`);
  const fm = parseFrontmatter((ctx.readFile ?? readFileSync)(abs, "utf8") as string);
  if (!fm.ok) return { json: { verb: "spec", subcommand: "validate", ok: false, errors: [fm.error] }, code: 65 };
  const v = validate(fm.data, "spec");
  return { json: { verb: "spec", subcommand: "validate", ok: v.ok, errors: v.errors }, code: v.ok ? 0 : 65 };
}

export interface SpecVerbCtx {
  readFile?: (p: string, enc: string) => string;
  spawnCritic?: ReviewOptions["spawnCritic"];
  queryLedger?: ReviewOptions["queryLedger"];
  round?: number;
}

export async function specVerb(argv: string[], ctx: SpecVerbCtx = {}): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "review") return review(rest, ctx);
  if (sub === "validate") return validateOnly(rest, ctx);
  return usageError(`unknown subcommand ${sub ? `"${sub}"` : "(none)"}`);
}
