// papers_digest_verb.ts — `amico papers digest [--feed q] [--top N] [--dry-run | --post <channel>]`
// (#412): fetch → rank against the lab corpus → dedup → print (dry-run default)
// or post to Slack as the Amico bot. The posted-state file makes reruns
// idempotent. Runs on the server (the Slack token is server-only by posture).
//
// living-sota slice 2 (spec-20260905-103000 D3): `--route` adds the digest's
// RELEVANCE ROUTER — the lab-corpus picks route against the active campaigns
// and stage into the per-campaign SIDECAR streams (below-threshold / no-match
// → the hopper stream), idempotent by event id. Routing is explicit (the
// daily job's act, never a side effect of a dry run) and NEVER fatal: a
// routing failure is a named `routed.errors` entry and the digest proceeds —
// the survey never blocks. `--feed-xml <file>` is the deterministic fixture
// seam (read the feed from a file instead of the wire — the same zero-dep
// escape as AMICO_PAPERS_VAULTS).
import {
  parseArxivRss,
  buildProfile,
  rankDigest,
  formatDigest,
  readPostedIds,
  writePostedIds,
  fetchFeed,
  feedUrl,
  digestFingerprint,
} from "./papers_digest.js";
import { foldCorpus } from "./papers.js";
import { studioPathsOrLegacy } from "@amicode/schema";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VerbResult } from "./verbs.js";
import { routePapersToStaging, type RoutePapersResult } from "./sota_router.js";
import { sotaSessionsDir } from "./sota_verb.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function slackPost(channelName: string, text: string): { ok: boolean; error?: string; ts?: string } {
  const tokenFile = join(homedir(), ".amico", "slack", "token");
  const channelsFile = join(homedir(), ".amico", "slack", "channels.json");
  if (!existsSync(tokenFile) || !existsSync(channelsFile))
    return { ok: false, error: "slack credentials not found (~/.amico/slack/{token,channels.json}) — run on the server" };
  const token = readFileSync(tokenFile, "utf8").trim();
  const channels = JSON.parse(readFileSync(channelsFile, "utf8")) as Record<string, string>;
  const cid = channels[channelName];
  if (!cid) return { ok: false, error: `unknown channel '${channelName}' (known: ${Object.keys(channels).join(", ")})` };
  // synchronous CLI context: curl is the zero-dep POST path
  const args = [
    "-sS", "-X", "POST", "https://slack.com/api/chat.postMessage",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-type: application/json; charset=utf-8",
    "--data-binary", JSON.stringify({ channel: cid, text, unfurl_links: false }),
  ];
  try {
    const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 1 << 20 });
    const j = JSON.parse(out) as { ok: boolean; error?: string; ts?: string };
    return j;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function papersDigestVerb(argv: string[]): Promise<VerbResult> {
  const feed = flagValue(argv, "--feed") ?? "quant-ph";
  const top = Number(flagValue(argv, "--top") ?? 5);
  const post = flagValue(argv, "--post");
  const dryRun = argv.includes("--dry-run") || post === undefined;
  const route = argv.includes("--route");
  const feedXml = flagValue(argv, "--feed-xml");
  const sessionsDir = flagValue(argv, "--sessions") ?? sotaSessionsDir();

  // hermetic escapes (tests) → studio ladder (production)
  const vaults = process.env.AMICO_PAPERS_VAULTS ?? studioPathsOrLegacy().vaultsRoot;
  const library = process.env.AMICO_PAPERS_LIBRARY ?? join(homedir(), ".amico", "library");

  let xml: string;
  if (feedXml !== undefined) {
    try {
      xml = readFileSync(feedXml, "utf8"); // the deterministic fixture seam — no transport
    } catch (e) {
      return { json: { ok: false, error: `--feed-xml unreadable: ${e}` }, code: 64 };
    }
  } else {
    try {
      xml = fetchFeed(feedUrl(feed));
    } catch (e) {
      return { json: { ok: false, error: `feed fetch failed: ${e}` }, code: 1 };
    }
  }
  const items = parseArxivRss(xml);
  if (items.length === 0) {
    return { json: { ok: false, error: `feed parsed to zero items (${feed}) — refusing to post an empty digest` }, code: 1 };
  }

  const corpus = foldCorpus([vaults], library);
  const profile = buildProfile(corpus);
  const posted = readPostedIds();
  const r = rankDigest(items, profile, corpus, { posted, top });

  if (r.picks.length === 0) {
    writePostedIds(r.skipped.posted); // no repost risk either way; state stays fresh
    return {
      json: { ok: true, posted: false, reason: "no items matched the lab profile today", total: items.length },
      code: 0,
    };
  }

  // the relevance router (living-sota D3): the picks stage into the campaign
  // SIDECARs / the hopper. Explicit (--route), NEVER fatal: a routing failure
  // is a named error and the digest proceeds — the survey never blocks.
  let routed: RoutePapersResult | undefined;
  const routingErrors: string[] = [];
  const routedField = () => (routed !== undefined || routingErrors.length > 0
    ? { routed: { staged: [], hopper: [], deduped: [], ...routed, errors: routingErrors } }
    : {});
  if (route) {
    try {
      routed = routePapersToStaging({
        items: r.picks.map((p) => ({ arxiv: p.item.arxiv, title: p.item.title, abstract: p.item.abstract })),
        sessionsDir,
        provenance: {
          job: "papers-digest",
          via: "feed",
          source: `arXiv RSS ${feed}`,
          fetched_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      routingErrors.push(`routing failed: ${(e as Error).message} — the digest proceeds; the router re-runs on the next pass`);
    }
  }

  const text = formatDigest({ feedName: feed, total: items.length, picks: r.picks, skipped: r.skipped });

  if (dryRun) {
    return {
      json: {
        ok: true,
        dry_run: true,
        text,
        fingerprint: digestFingerprint(text),
        counts: { total: items.length, picks: r.picks.length, skipped_corpus: r.skipped.corpus.length, dropped: r.dropped.length },
        ...routedField(),
      },
      code: 0,
    };
  }

  const res = slackPost(post!, text);
  if (!res.ok) return { json: { ok: false, error: `slack post failed: ${res.error}` }, code: 1 };
  writePostedIds(r.picks.map((p) => p.item.arxiv));
  return {
    json: {
      ok: true,
      posted: true,
      channel: post,
      ts: res.ts,
      fingerprint: digestFingerprint(text),
      counts: { total: items.length, picks: r.picks.length },
      ...routedField(),
    },
    code: 0,
  };
}
