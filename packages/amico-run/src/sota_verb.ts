// sota_verb.ts — `amico sota …` (#820 + living-sota slice 2, spec
// spec-20260905-103000 D1/D3): the SOTA survey surface agents drive.
//
//   papers | codebase  — the slice-1 read-only lenses (fetch + report)
//   watcher           — the SOTA watcher: one codebase-lens round ROUTED
//                       through the staged path (stage lines; hopper fallback)
//   accept            — the PI-instructed acceptance stamp: the SOLE
//                       sanctioned non-job append (an agent records the human
//                       decision on the explicit instruction; --note required)
//   awaiting-the-eye  — the pending listing, rendered from DERIVED state
//                       (never currency; expired-without-review counts ride)
//   sweep             — the weekly job's expiry + compaction driver (O2)
//
// The survey never blocks: every failure is a NAMED outcome with the
// disclosed alternative, never a hang, never a silent empty. ONE APPENDER:
// watcher/sweep are the job drivers (the only stage/drop writers); accept is
// the sanctioned human-instructed exception.
import type { VerbResult } from "./verbs.js";
import { runPapersLens } from "./sota_papers.js";
import { runCodebaseLens } from "./sota_codebase.js";
import { sotaRoot } from "./sota_fetch.js";
import { runSotaWatcher } from "./sota_watcher.js";
import { appendAcceptStamp, renderAwaitingTheEye, sweepExpiry, compactStagingStream, listStagingStreams, stagingStreamPath, expiredWithoutReviewCount, deriveStagingState } from "./sota_staging.js";
import { resolveMountStack, personalMount } from "./mounts.js";
import { join } from "node:path";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
}

/** The sessions dir the staged routing enumerates/writes: $AMICO_SOTA_SESSIONS
 *  wins (hermetic escape); production is the personal vault mount's sessions/
 *  — the session-ledger parse target. */
export function sotaSessionsDir(): string {
  const env = process.env.AMICO_SOTA_SESSIONS;
  if (env && env.trim() !== "") return env;
  const stack = resolveMountStack();
  const personal = personalMount(stack);
  return join(personal?.path ?? "", "sessions");
}

/** A campaign stem names its sidecar under sessions/ — a file name, never a
 *  path (the traversal guard doubles as the shape check). */
const CAMPAIGN_STEM_OK = /^(session-[A-Za-z0-9_-]+|hopper)$/;

const USAGE = `amico sota — the SOTA survey surface (read-only toward the world; staged routing for the loop)
  amico sota papers --query "<terms>" [--top N] [--root <sota-root>]
      one on-demand arXiv query through the fleet-wide serialized queue
  amico sota codebase [--repo owner/name]... [--root <sota-root>]
      one watched-repo fetch round via the GitHub API against canonical repos
  amico sota watcher [--repo owner/name]... [--root <sota-root>] [--sessions <dir>]
      the SOTA watcher: the codebase round routed through the staged streams
  amico sota accept --campaign <ledger-stem> --event <event-id> --note "<PI instruction>" [--sessions <dir>]
      the PI-instructed acceptance stamp (the sole sanctioned non-job append)
  amico sota awaiting-the-eye [--sessions <dir>]
      the pending staged matches + expired-without-review counts (derived state)
  amico sota sweep [--sessions <dir>]
      the weekly job's expiry drops + compaction pass over every staging stream`;

export async function sotaVerb(argv: string[]): Promise<VerbResult> {
  const head = argv[0] ?? "";
  const root = flagValue(argv, "--root") ?? sotaRoot();
  const sessions = flagValue(argv, "--sessions") ?? sotaSessionsDir();

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

  if (head === "watcher") {
    const repos = flagValues(argv, "--repo");
    for (const r of repos) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
        return { json: { ok: false, error: `watcher: --repo must be a canonical owner/name (got "${r}") — never a local checkout path` }, code: 64 };
      }
    }
    const res = await runSotaWatcher({ root, sessionsDir: sessions, repos: repos.length > 0 ? repos : undefined });
    return {
      json: {
        ok: true,
        staged: res.staged,
        hopper: res.hopper,
        deduped: res.deduped,
        lens_ok: res.lens.ok,
        brief: res.lens.brief,
      },
      code: 0,
    };
  }

  if (head === "accept") {
    const campaign = flagValue(argv, "--campaign");
    const event = flagValue(argv, "--event");
    const note = flagValue(argv, "--note");
    const channel = flagValue(argv, "--channel") ?? "chat";
    if (!campaign || !event || !note || note.trim() === "") {
      return { json: { ok: false, error: "accept: --campaign, --event, and --note are all required (the stamp records the PI's explicit instruction — an unstamped acceptance is refused)", usage: USAGE }, code: 64 };
    }
    if (!CAMPAIGN_STEM_OK.test(campaign)) {
      return { json: { ok: false, error: `accept: --campaign must be a session-ledger stem (or "hopper") naming its sidecar — got "${campaign}"` }, code: 64 };
    }
    const res = appendAcceptStamp(stagingStreamPath(sessions, campaign), event, { channel, note });
    if (!res.appended) {
      // already-accepted is the idempotent success; every other refusal is the named failure
      if (/already-accepted/i.test(res.reason)) return { json: { ok: true, idempotent: true, detail: res.reason }, code: 0 };
      return { json: { ok: false, error: res.reason }, code: 1 };
    }
    return { json: { ok: true, accepted: event, campaign }, code: 0 };
  }

  if (head === "awaiting-the-eye") {
    const stems = listStagingStreams(sessions);
    const paths = stems.map((s) => stagingStreamPath(sessions, s));
    const text = renderAwaitingTheEye(paths);
    let pending = 0;
    let expired = 0;
    for (const p of paths) {
      const { entries } = deriveStagingState(p);
      pending += [...entries.values()].filter((e) => e.state === "staged").length;
      expired += expiredWithoutReviewCount(p);
    }
    return { json: { ok: true, text, pending, expired_without_review: expired, streams: stems }, code: 0 };
  }

  if (head === "sweep") {
    const stems = listStagingStreams(sessions);
    const streams = stems.map((campaign) => {
      const path = stagingStreamPath(sessions, campaign);
      const { dropped } = sweepExpiry(path);
      const { removed } = compactStagingStream(path);
      return { campaign, dropped, compacted: removed };
    });
    return { json: { ok: true, streams }, code: 0 };
  }

  return { json: { ok: false, error: `sota: unknown lens "${head}"`, usage: USAGE }, code: 64 };
}
