// sota_watcher.ts — the SOTA watcher (#living-sota slice 2, spec
// spec-20260905-103000 D3 / S3): release/changelog/issue events from the
// watched-repo registry ride the IDENTICAL staged path as papers. The slice-1
// codebase lens (sota_codebase.ts) provides the FETCH — the GitHub API against
// canonical repos, through the one-fetcher seam, never a local fork checkout;
// the watcher adds the ROUTING: the lens's keyword-matched events enumerate
// the active campaigns (sota_router.ts) and append stage lines through the
// same sota_staging machinery — same hopper fallback, same review-by/expiry
// stamps, same event-id idempotency (double delivery impossible).
//
// ONE APPENDER (D4): the watcher is one of the ONLY three stage/drop writers
// (digest, watcher, weekly synthesis); concurrent agents signal matches, the
// job dedupes centrally by event id. A fetch-failed surface is a NAMED failure
// in the round — the watcher never silently skips, and stages nothing for it
// (the entry accrues toward retire-or-confirm in the registry, slice 1).
import { runCodebaseLens, type CodebaseEvent, type CodebaseLensOpts, type CodebaseLensResult } from "./sota_codebase.js";
import type { FetchSurface } from "@amicode/schema";
import { enumerateCampaigns, routeItem, REASON_BELOW_THRESHOLD, REASON_NO_CAMPAIGN_MATCH, type CampaignLedgerInfo } from "./sota_router.js";
import { appendStageLine, stagingStreamPath, HOPPER_CAMPAIGN, type StagingProvenance } from "./sota_staging.js";

/** The watcher's opts: the codebase lens round (root, fetchFn, clock, queue
 *  overrides) + the sessions dir the routing enumerates. */
export interface SotaWatchOpts extends CodebaseLensOpts {
  sessionsDir: string;
}

export interface WatcherEvent {
  event_id: string;
  campaign: string;
  matched: string[];
}

export interface WatcherResult {
  lens: CodebaseLensResult;
  staged: WatcherEvent[];
  hopper: { event_id: string; reason: string }[];
  deduped: string[];
}

const KIND_BY_SURFACE: Record<FetchSurface, "release" | "changelog" | "issue"> = {
  releases: "release",
  changelog: "changelog",
  issues: "issue",
};

/** One watcher round: the codebase lens's fetch + the identical routing pass.
 *  Every matched event — whatever the campaign enumeration matches — stages
 *  through sota_staging (idempotent by event id); below-threshold and
 *  no-campaign events go to the hopper stream. */
export async function runSotaWatcher(opts: SotaWatchOpts): Promise<WatcherResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const lens = await runCodebaseLens(opts);
  const { campaigns } = enumerateCampaigns(opts.sessionsDir);
  const stampIso = lens.stamp.iso;
  const staged: WatcherEvent[] = [];
  const hopper: { event_id: string; reason: string }[] = [];
  const deduped: string[] = [];
  for (const repo of lens.repos) {
    for (const surface of repo.surfaces) {
      for (const e of surface.events) {
        const route = routeItem({ title: e.title, detail: e.detail }, campaigns);
        const campaign = route.target === "campaign" ? route.campaign.id : HOPPER_CAMPAIGN;
        const event_id = `github:${e.id}`;
        const provenance: StagingProvenance = {
          job: "sota-watcher",
          via: surface.via,
          source: "GitHub API against canonical repos",
          fetched_at: stampIso,
          repo: repo.repo,
          surface: surface.surface,
        };
        const r = appendStageLine(
          stagingStreamPath(opts.sessionsDir, campaign),
          {
            event_id,
            campaign,
            kind: KIND_BY_SURFACE[surface.surface],
            title: e.title,
            url: e.url,
            provenance,
            matched: route.matched,
            ...(route.target === "hopper" ? { reason: route.reason } : {}),
          },
          { nowMs },
        );
        if (!r.appended) {
          deduped.push(event_id);
          continue;
        }
        if (route.target === "hopper") hopper.push({ event_id, reason: route.reason });
        else staged.push({ event_id, campaign, matched: route.matched });
      }
    }
  }
  return { lens, staged, hopper, deduped };
}
