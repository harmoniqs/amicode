// `amico campaign` — the SEAM 7 (#709) CLI surface for the flywheel metric.
// The non-UI delivery path: the panel surfacing is the fork-flow follow-up
// (the SEAM 1 UI-half pattern), so the computation ships behind a verb first.
//
//   amico campaign decay [--runs-root <dir>] [--task-root <dir>] [--store-root <dir>]
//
// Prints (as JSON, per the repo's verb contract) the decay trend per campaign
// family: the campaigns, their counts, the three metrics' deltas vs the prior
// same-family campaign, and the named F4 findings. EXISTING records only —
// the verb reads, it never stamps. Defaults: --runs-root is the studio runs
// root (AMICODE_STUDIO_CONFIG manifest → legacy ~/.amico/runs); --task-root
// has no machine default (strumento task records are not an amico-owned
// surface — pass the root explicitly); --store-root defaults to the pulse
// bank (catalogPulsesDir).
import { studioPathsOrLegacy } from "@amicode/schema";
import { catalogPulsesDir } from "./repertoire.js";
import { computeDecay, type DecayReport } from "./flywheel.js";
import type { VerbResult } from "./verbs.js";

function collectFlags(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) out.push(argv[i + 1]!);
  }
  return out;
}

export function campaignVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  if (sub !== "decay") {
    return {
      json: {
        verb: "campaign",
        error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
        usage: "amico campaign decay [--runs-root <dir>] [--task-root <dir>] [--store-root <dir>]",
      },
      code: 64,
    };
  }

  const rest = argv.slice(1);
  const runsRoots = collectFlags(rest, "--runs-root");
  const taskRoots = collectFlags(rest, "--task-root");
  const storeRoots = collectFlags(rest, "--store-root");
  const unknown = rest.filter((a, i) => (a.startsWith("--") ? !["--runs-root", "--task-root", "--store-root"].includes(a) : i === 0 || !rest[i - 1]!.startsWith("--")));
  if (unknown.length > 0) {
    return {
      json: {
        verb: "campaign",
        subcommand: "decay",
        error: `unknown flag(s): ${unknown.join(", ")}`,
        usage: "amico campaign decay [--runs-root <dir>] [--task-root <dir>] [--store-root <dir>]",
      },
      code: 64,
    };
  }

  const runs = runsRoots.length > 0 ? runsRoots : [studioPathsOrLegacy().runs];
  const stores = storeRoots.length > 0 ? storeRoots : [catalogPulsesDir()];

  const report: DecayReport = computeDecay({
    runsRoots: runs,
    taskRoots,
    storeRoots: stores,
  });

  return {
    json: {
      verb: "campaign",
      subcommand: "decay",
      runs_root: runs,
      tasks_root: taskRoots.length > 0 ? taskRoots : null,
      store_root: stores,
      ...report,
    },
    code: 0,
  };
}
