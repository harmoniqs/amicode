// sota_verb.ts — `amico sota papers|codebase` (#820, spec-20260905-103000
// living-sota D1): the SOTA survey surface agents drive — one on-demand
// arXiv query through the fleet-wide serialized queue (papers lens), or one
// watched-repo fetch round via the GitHub API (codebase lens). Both are the
// one-fetcher seam's clients: cache → queue → fetch, never a direct
// transport. The survey never blocks: queue-timeout and fetch failures are
// NAMED outcomes with the disclosed alternative (read the cache, or record
// the waiver) — exit 1 with the named reason, never a hang, never a silent
// empty.
import type { VerbResult } from "./verbs.js";
import { runPapersLens } from "./sota_papers.js";
import { runCodebaseLens } from "./sota_codebase.js";
import { sotaRoot } from "./sota_fetch.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

const USAGE = `amico sota — the SOTA survey surface (read-only toward the world)
  amico sota papers --query "<terms>" [--top N] [--root <sota-root>]
      one on-demand arXiv query through the fleet-wide serialized queue
  amico sota codebase [--repo owner/name]... [--root <sota-root>]
      one watched-repo fetch round via the GitHub API against canonical repos`;

export async function sotaVerb(argv: string[]): Promise<VerbResult> {
  const head = argv[0] ?? "";
  const root = flagValue(argv, "--root") ?? sotaRoot();

  if (head === "papers") {
    const query = flagValue(argv, "--query");
    if (!query || query.trim() === "") return { json: { ok: false, error: "papers lens: --query is required" }, code: 64 };
    const maxResults = Number(flagValue(argv, "--top") ?? 5);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      return { json: { ok: false, error: `papers lens: --top must be an integer in [1, 50] (got "${flagValue(argv, "--top")}")` }, code: 64 };
    }
    const res = await runPapersLens({ root, terms: [query.trim()], maxResults });
    if (!res.ok) {
      return { json: { ok: false, via: res.via, detail: res.detail, brief: res.brief }, code: 1 };
    }
    return {
      json: {
        ok: true,
        via: res.via,
        results: res.entries.length,
        brief: res.brief,
        entries: res.entries.map((e) => ({ arxiv: e.arxiv, title: e.title, url: `https://arxiv.org/abs/${e.arxiv}`, published: e.published })),
        anomaly: res.anomaly,
        provenance: res.stamp,
      },
      code: 0,
    };
  }

  if (head === "codebase") {
    const repos = flagValues(argv, "--repo");
    for (const r of repos) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
        return { json: { ok: false, error: `codebase lens: --repo must be a canonical owner/name (got "${r}") — never a local checkout path` }, code: 64 };
      }
    }
    const res = await runCodebaseLens({ root, repos: repos.length > 0 ? repos : undefined });
    return {
      json: {
        ok: res.ok,
        brief: res.brief,
        stamped_at: res.stamp.iso,
        repos: res.repos.map((r) => ({
          repo: r.repo,
          ok: r.ok,
          flagged_for_retire_or_confirm: r.flagged,
          events: r.surfaces.reduce((t, s) => t + s.events.length, 0),
        })),
      },
      code: res.ok ? 0 : 1,
    };
  }

  return { json: { ok: false, error: `sota: unknown lens "${head}"`, usage: USAGE }, code: 64 };
}
