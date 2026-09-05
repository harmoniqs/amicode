// sota_papers.test.ts — the PAPERS lens (#820, spec spec-20260905-103000
// living-sota D1 / S1): on-demand arXiv queries through the fleet-wide
// serialized queue, cited + provenance-stamped PI-register briefs, the recipe
// gotcha mechanical (https only — the export API's http endpoint silently
// hangs). The REAL-API hermetic fixture (one call, cached) is
// test/fixtures/sota/arxiv-live-atom.xml — the recorded payload of a single
// real export.arxiv.org call made through the production transport at
// authoring time; the live-gated describe below re-verifies the full
// queue+cache path on demand (AMICO_SOTA_LIVE=1).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARXIV_API_ENDPOINT,
  arxivApiUrl,
  parseArxivAtom,
  papersBrief,
  runPapersLens,
  absUrlOf,
  type ArxivEntry,
} from "../src/sota_papers.js";
import { cachePath, sourceKeyOf, type SotaFetch } from "../src/sota_fetch.js";
import { recordFetchOutcome } from "../src/sota_history.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-papers-"));
}

function vclock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

// A real-shaped Atom fixture (the export API's shape: entry/id → abs/<id>,
// title, summary, published, authors). Entities, CDATA, multi-entry.
const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query=all:test" rel="self" type="application/atom+xml"/>
  <entry>
    <id>http://arxiv.org/abs/2606.05060v2</id>
    <updated>2026-06-10T00:00:00Z</updated>
    <published>2026-06-05T00:00:00Z</published>
    <title>A Hessian method for &amp; optimal control</title>
    <summary>  We study pulse synthesis with &lt;drags&gt; <![CDATA[and <raw> CDATA things]]> for superconducting qubits.  </summary>
    <author><name>A. Researcher</name></author>
    <author><name>B. Author</name></author>
    <link href="http://arxiv.org/abs/2606.05060v2" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2607.11111v1</id>
    <published>2026-07-01T00:00:00Z</published>
    <title>Another survey of neutral atoms</title>
    <summary>Blockade gates and arrays.</summary>
    <author><name>C. Writer</name></author>
  </entry>
</feed>`;

describe("arxivApiUrl — the query builder targets the REAL export API over HTTPS", () => {
  it("builds the canonical export-API query URL (https, search_query, max_results)", () => {
    expect(ARXIV_API_ENDPOINT).toBe("https://export.arxiv.org/api/query");
    const url = arxivApiUrl(["optimal control", "qubit"], 5);
    expect(url.startsWith(`${ARXIV_API_ENDPOINT}?search_query=`)).toBe(true);
    expect(url).toContain("max_results=5");
    expect(url).toContain(encodeURIComponent("all:optimal control"));
    expect(url).toContain(encodeURIComponent("AND"));
    expect(url.startsWith("https://")).toBe(true); // the recipe gotcha is structural: the builder cannot emit http
  });

  it("empty terms is a usage error (never a wildcard firehose)", () => {
    expect(() => arxivApiUrl([], 5)).toThrow(/at least one/);
  });
});

describe("parseArxivAtom — the zero-dep Atom subset (the parseArxivRss idiom)", () => {
  it("extracts id/title/abstract/published/authors from the real API's shape", () => {
    const entries = parseArxivAtom(ATOM_FIXTURE);
    expect(entries).toHaveLength(2);
    const first = entries[0];
    expect(first.arxiv).toBe("2606.05060");
    expect(first.title).toBe("A Hessian method for & optimal control");
    expect(first.abstract).toMatch(/pulse synthesis with and CDATA things/); // entities unescaped, then inner pseudo-tags stripped (the digest idiom)
    expect(first.published.startsWith("2026-06-05")).toBe(true);
    expect(first.authors).toEqual(["A. Researcher", "B. Author"]);
    expect(absUrlOf(first)).toBe("https://arxiv.org/abs/2606.05060"); // the CITATION url — https, the landing page
  });

  it("malformed input degrades to [] — a bad payload never crashes the lens", () => {
    expect(parseArxivAtom("")).toEqual([]);
    expect(parseArxivAtom("not xml at all")).toEqual([]);
    expect(parseArxivAtom("<feed><entry><id>http://elsewhere/x</id></entry></feed>")).toEqual([]);
  });
});

describe("papersBrief — the PI-register brief: cited, provenance-stamped", () => {
  const entries = parseArxivAtom(ATOM_FIXTURE);
  const stamp = {
    query: "optimal control",
    url: arxivApiUrl(["optimal control"], 5),
    fetched_at: "2026-09-05T12:00:00Z",
    via: "fetched" as const,
  };

  it("leads with the outcome, cites every entry with its abs URL, stamps provenance", () => {
    const brief = papersBrief({ entries, stamp, anomaly: { armed: false, anomaly: false } });
    const lines = brief.split("\n");
    expect(lines[0]).toMatch(/^# SOTA papers brief/);
    expect(lines[0]).toMatch(/2 results/); // the outcome leads
    for (const e of entries) expect(brief).toContain(`[arXiv:${e.arxiv}](${absUrlOf(e)})`); // CITED
    expect(brief).toContain("A. Researcher"); // details-informed: authors render
    expect(brief).toMatch(/provenance:/); // STAMPED
    expect(brief).toContain("source: arXiv export API over HTTPS");
    expect(brief).toContain("fetched_at: 2026-09-05T12:00:00Z");
    expect(brief).toContain("via: fetched");
    expect(brief).toContain("query: optimal control");
  });

  it("an armed anomaly renders 'scan returned nothing — anomalous' — NEVER 'nothing new'", () => {
    // the anomaly only fires on an EMPTY scan — entries is [] here (the floor's semantics)
    const brief = papersBrief({
      entries: [],
      stamp,
      anomaly: {
        armed: true,
        anomaly: true,
        name: "empty-200-vs-nonzero-mean",
        mean: 4.2,
        render: "scan returned nothing — anomalous (empty 200 against a trailing 7-fetch-day mean of 4.2)",
      },
    });
    expect(brief).toContain("scan returned nothing — anomalous");
    expect(brief).not.toMatch(/nothing new/i); // the silent-empty failure mode, banned verbatim
  });

  it("zero entries, floor unarmed → the HONEST unarmed line (not 'nothing new' either)", () => {
    const brief = papersBrief({ entries: [], stamp, anomaly: { armed: false, anomaly: false } });
    expect(brief).toContain("no results");
    expect(brief).not.toMatch(/nothing new/i);
  });
});

describe("runPapersLens — the on-demand query through the queue (D1/D4)", () => {
  it("fetches through the queue, parses, and renders a cited brief", async () => {
    const r = root();
    const c = vclock();
    const res = await runPapersLens({
      root: r,
      terms: ["optimal control"],
      maxResults: 5,
      fetchFn: (async () => ({ ok: true as const, status: 200, body: ATOM_FIXTURE, count: 2 })) as SotaFetch,
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    expect(res.via).toBe("fetched");
    if (!res.ok) throw new Error("setup: must be ok");
    expect(res.entries).toHaveLength(2);
    expect(res.brief).toContain("[arXiv:2606.05060]");
    expect(res.brief).toMatch(/provenance:.*source: arXiv export API over HTTPS/s);
  });

  it("an armed floor over a seeded history renders anomalous in the brief", async () => {
    const r = root();
    const c = vclock();
    const url = arxivApiUrl(["optimal control"], 5);
    // 7 prior fetch-days of nonzero history → the floor is armed
    for (let i = 0; i < 7; i++) {
      recordFetchOutcome(r, sourceKeyOf(url), { date: `2026-08-0${i + 1}`, count: 4 });
    }
    const res = await runPapersLens({
      root: r,
      terms: ["optimal control"],
      maxResults: 5,
      fetchFn: (async () => ({ ok: true as const, status: 200, body: "", count: 0 })) as SotaFetch, // empty 200
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    if (!res.ok) throw new Error("setup: must be ok");
    expect(res.entries).toHaveLength(0);
    expect(res.anomaly?.anomaly).toBe(true);
    expect(res.brief).toContain("scan returned nothing — anomalous"); // never "nothing new"
    expect(res.brief).not.toMatch(/nothing new/i);
  });

  it("the queue-timeout fall-through renders the NAMED outcome (the survey never blocks)", async () => {
    const r = root();
    const c = vclock();
    // a foreign lease that will never expire inside the bounded wait
    mkdirSync(join(r), { recursive: true });
    writeFileSync(join(r, "queue.lock"), JSON.stringify({ token: "foreign", acquired_at: 0, expires_at: c.nowMs() + 10_000_000 }) + "\n");
    const res = await runPapersLens({
      root: r,
      terms: ["optimal control"],
      maxResults: 5,
      fetchFn: (async () => ({ ok: true as const, status: 200, body: ATOM_FIXTURE, count: 2 })) as SotaFetch,
      nowMs: c.nowMs,
      sleep: c.sleep,
      waitTimeoutMs: 500,
    });
    expect(res.via).toBe("queue-timeout");
    expect(res.brief).toContain("queue-timeout"); // the named outcome renders
    expect(res.brief).toMatch(/cache|waiver/i); // the disclosed alternative
  });
});

describe("the REAL-API hermetic fixture (S1 — one call, cached)", () => {
  // The committed fixture is the payload of ONE real
  // https://export.arxiv.org/api/query call (made through the production
  // transport; the live-gated describe re-verifies). The hermetic body below
  // seeds the FETCH cache with that payload and proves the lens serves it
  // THROUGH the queue machinery with ZERO transports — the one call happened
  // once; the cache is what everyone after reads.
  const FIXTURE = join(__dirname, "fixtures", "sota", "arxiv-live-atom.xml");
  // The anchor: the recorded call's own harvest time — the feed's <updated>
  // stamp of the recorded response (2026-09-05T18:22:20Z). The cache reads
  // fresh only inside the TTL window of fetched_at — a FIXED pair, so the
  // test is deterministic.
  const FETCHED_AT = "2026-09-05T18:22:20Z";

  function parseAtomFixture(): string {
    return readFileSync(FIXTURE, "utf8");
  }

  it("the committed fixture exists and is the real API's Atom shape", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const body = parseAtomFixture();
    expect(body).toContain("http://arxiv.org/abs/");
    expect(parseArxivAtom(body).length).toBeGreaterThan(0);
  });

  it("the lens serves the cached REAL payload through the queue — zero transports (a second fetcher reads the cache)", async () => {
    const r = root();
    const body = parseAtomFixture();
    const url = arxivApiUrl(["optimal control"], 5);
    // seed the FETCH cache with the fixture payload (the one real call's harvest)
    mkdirSync(join(r, "fetch-cache"), { recursive: true });
    writeFileSync(cachePath(r, url), JSON.stringify({ url, fetched_at: FETCHED_AT, body }) + "\n");
    let transports = 0;
    const res = await runPapersLens({
      root: r,
      terms: ["optimal control"],
      maxResults: 5,
      fetchFn: (async () => {
        transports += 1;
        return { ok: true as const, status: 200, body: "", count: 0 };
      }) as SotaFetch,
      nowMs: () => Date.parse(FETCHED_AT) + 60_000, // 60s after the harvest — inside the TTL window
      sleep: async () => {},
    });
    expect(res.via).toBe("cache"); // the S6 property, at the lens
    if (!res.ok) throw new Error("setup: must be ok");
    expect(transports).toBe(0); // the real call happened ONCE; this fetcher reads the cache
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.brief).toMatch(/via: cache/); // the brief's provenance says cache — honest, never laundering a live fetch
    // and a second lens run also reads the cache (fleet dedup)
    const res2 = await runPapersLens({
      root: r,
      terms: ["optimal control"],
      maxResults: 5,
      fetchFn: (async () => {
        transports += 1;
        return { ok: true as const, status: 200, body: "", count: 0 };
      }) as SotaFetch,
      nowMs: () => Date.parse(FETCHED_AT) + 61_000,
      sleep: async () => {},
    });
    expect(res2.via).toBe("cache");
    if (!res2.ok) throw new Error("setup: must be ok");
    expect(transports).toBe(0);
  });
});

describe("the live arXiv call through the queue (opt-in — AMICO_SOTA_LIVE=1)", () => {
  // The ONE sanctioned live path: the production curl transport against the
  // real export API, through the fleet-wide queue, writing the cache. Skipped
  // unless explicitly requested — the committed fixture carries the evidence
  // for the hermetic suite; this re-verifies the wire on demand.
  it.skipIf(process.env.AMICO_SOTA_LIVE !== "1")("hits the real API over HTTPS through the queue and caches", async () => {
    const r = root();
    const res = await runPapersLens({ root: r, terms: ["optimal control"], maxResults: 5 });
    expect(res.via).toBe("fetched");
    if (!res.ok) throw new Error("live: must be ok");
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.brief).toMatch(/provenance:/);
  });
});
