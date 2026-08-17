// `amico papers` — the unified literature corpus surface (#405):
//
//   amico papers list [--status staged|distilled] [--tag <t>] [--platform <s>] [--q <substr>] [--json]
//       → the corpus fold rendered: a human table by default (title · identity
//         · status · pdf?), JSON on --json. Counts + drift (duplicates,
//         orphans both ways) ride along — collect, unify, usable, searchable.
//
// Read-only (the fold never writes). $AMICO_PAPERS_VAULTS / $AMICO_PAPERS_LIBRARY
// are the hermetic test escapes; production roots come from the studio ladder.
import { papersList } from "./papers_list.js";
import type { VerbResult } from "./verbs.js";

export function papersVerb(argv: string[]): VerbResult {
  const [sub, ...rest] = argv;
  if (sub !== "list") {
    return {
      json: { ok: false, error: `papers: unknown subcommand '${sub ?? ""}' — usage: amico papers list [--status|--tag|--platform|--q] [--json]` },
      code: 64,
    };
  }
  return papersList(rest);
}
