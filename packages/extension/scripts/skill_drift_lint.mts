#!/usr/bin/env node
// Skill-content drift lint CLI (amicode#586). Deterministic, no network, no
// clock, no LLM — the report-mode half of the freshness cadence (the nightly
// job, issue #587, consumes this).
//
//   node scripts/skill_drift_lint.mts [--skills <dir>] [--packages <root>]...
//                                      [--structural-only] [--min-skills <n>]
//                                      [--report json|text] [--out <file>]
//
//   --skills <dir>        skills library root (default: this repo's public
//                         library, packages/extension/skills)
//   --packages <root>     package-checkout root containing <Pkg>.jl dirs;
//                         repeatable, comma-separated ok. Absent → paths/symbols
//                         with no other resolution are UNVERIFIABLE.
//   --structural-only     structure only, zero package cross-check (the CI lane)
//   --min-skills <n>      fail structurally when fewer than n skills were
//                         linted (default 0 = no floor) — distinguishes
//                         "clean" from "linted nothing" for the nightly job
//   --report json|text    stdout format (default json — machine-readable,
//                         per-skill per-claim; text is the human listing)
//   --out <file>          write the report to a file instead of stdout
//
// Exit codes (review NIT — the contract, in one table):
//   0  ok — zero structural failures (semantic drift alone never fails;
//      report-mode by design, the nightly cadence owns escalation)
//   1  structural failure — malformed frontmatter, duplicate skill names,
//      broken relative refs, an existing-but-unreadable skills dir under
//      requireSkillsDir (strict mode), or the --min-skills floor not met
//   2  usage / pre-flight error — bad arguments, or the --skills dir does
//      not exist (missing ≠ unreadable: a MISSING dir is caught here by
//      the CLI pre-flight with exit 2, while an EXISTING-but-unreadable
//      dir passes pre-flight and fails structurally with exit 1 — the
//      EACCES-vs-missing divergence)
//
// Runs on any node with native TS type-stripping (≥22.18 default-on; the
// mini's node 26 qualifies — same pattern as scripts/updater_live_drill.mts).
// The vitest suite covers the pure helpers in src/scores/skill_drift_lint.ts
// on CI's node 20 and smoke-runs this file end-to-end where the runtime
// supports it.
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lintSkillsDir,
  parseLintArgs,
  lintExitCode,
  renderSummary,
  renderTextReport,
} from "../src/scores/skill_drift_lint.ts";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: node scripts/skill_drift_lint.mts [--skills <dir>] [--packages <root>]...
                                        [--structural-only] [--min-skills <n>]
                                        [--report json|text] [--out <file>]`;

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseLintArgs(argv, { defaultSkillsDir: join(EXT_ROOT, "skills") });
  if ("error" in parsed) {
    console.error(`skill-drift-lint: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  // The CLI names its dirs explicitly — a dir that does not exist is a usage
  // error, never a silently-ok empty report (integration-gate finding, #586).
  if (!fs.statSync(parsed.skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`skill-drift-lint: skills dir not found: ${parsed.skillsDir}\n${USAGE}`);
    return 2;
  }
  const report = lintSkillsDir(parsed.skillsDir, parsed.packageRoots, {
    structuralOnly: parsed.structuralOnly,
    requireSkillsDir: true, // defense in depth vs. the pre-validation race
    minSkills: parsed.minSkills,
  });
  const body = parsed.reportFormat === "text" ? renderTextReport(report) : JSON.stringify(report, null, 2);
  if (parsed.outFile) {
    fs.writeFileSync(parsed.outFile, body + "\n");
    console.error(`skill-drift-lint: report written to ${parsed.outFile}`);
  } else {
    console.log(body);
  }
  console.error(renderSummary(report)); // the human summary rides stderr
  return lintExitCode(report);
}

// run only when executed as a script (imports for testing stay side-effect-free)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
