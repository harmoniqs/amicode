// packages/amico-run/src/census_verb.ts — `amico census` (rd-system v2.1 A0b, #1902).
//
//   amico census [--brief] [--prd <owner/repo#n>] [--repo <owner/repo>] [--base <branch>]
//                [--window-days <n>] [--manifest <manifest.json>] [--deploy-record <path>]
//
// Read-only. Emits the census JSON (render timestamp + per-source coverage, `stalled_since`,
// `top_line`); `--brief` prints the 3–6 line markdown rendering for the morning brief instead.
// CLI-only (a top-level case in amico.ts, not a SPINE_VERBS entry), like `cloud`: it needs a
// non-JSON stdout for `--brief`, and wiring into the notturno brief is the brief's own slice.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRD, DEFAULT_REPO, DEFAULT_WINDOW_DAYS, buildCensus, ghApiCensus, renderBrief, type CensusGh } from "./census.js";
import type { IssueAddr } from "./spec_slices.js";
import type { VerbResult } from "./verbs.js";

const USAGE =
  "amico census [--brief] [--prd <owner/repo#n>] [--repo <owner/repo>] [--base <branch>] [--window-days <n>] [--manifest <manifest.json>] [--deploy-record <path>]";

const VALUE_FLAGS = new Set(["--prd", "--repo", "--base", "--window-days", "--manifest", "--deploy-record"]);
const BOOL_FLAGS = new Set(["--brief", "--json"]);

export interface CensusVerbCtx {
  gh?: CensusGh;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** The repo's own manifest, resolved from this source file (src/ → ../../app-bundle). A bundled
 *  build that moved the file resolves elsewhere and renders an honest gap; pass --manifest. */
export function defaultManifestPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app-bundle", "manifest.json");
}

/** The live dist's deploy provenance stamp (build_app_bundle.mjs), the frontdoor's APP_DIST. */
export function defaultDeployRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AMICO_DEPLOY_RECORD) return env.AMICO_DEPLOY_RECORD;
  return join(env.AMICODE_APP_DIST ?? join(homedir(), ".amico", "server", "service", "dist-app"), "deploy.json");
}

function usage(error: string): VerbResult {
  return { json: { verb: "census", ok: false, error, usage: USAGE }, code: 64 };
}

export async function censusVerb(argv: string[], ctx: CensusVerbCtx = {}): Promise<VerbResult & { brief?: string }> {
  const flags = new Map<string, string>();
  let brief = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--brief") brief = true;
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return usage(`${a} needs a value`);
      flags.set(a, v);
      i++;
    } else if (a === "--help" || a === "-h") return { json: { verb: "census", usage: USAGE }, code: 0 };
    else return usage(`unknown argument "${a}"`);
  }

  let prd: IssueAddr = DEFAULT_PRD;
  if (flags.has("--prd")) {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(flags.get("--prd")!);
    if (!m) return usage(`--prd must be <owner/repo#n>, got "${flags.get("--prd")}"`);
    prd = { repo: m[1], number: Number(m[2]) };
  }
  const repo = flags.get("--repo") ?? DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return usage(`--repo must be <owner/repo>, got "${repo}"`);
  let windowDays = DEFAULT_WINDOW_DAYS;
  if (flags.has("--window-days")) {
    const raw = flags.get("--window-days")!;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return usage(`--window-days must be a positive integer, got "${raw}"`);
    windowDays = Number(raw);
  }

  const census = buildCensus({
    gh: ctx.gh ?? ghApiCensus(),
    now: (ctx.now ?? (() => new Date()))(),
    prd,
    repo,
    base: flags.get("--base") ?? "main",
    windowDays,
    manifestPath: flags.get("--manifest") ?? defaultManifestPath(),
    deployRecordPath: flags.get("--deploy-record") ?? defaultDeployRecordPath(ctx.env),
  });
  return { json: census, code: 0, ...(brief ? { brief: renderBrief(census) } : {}) };
}
