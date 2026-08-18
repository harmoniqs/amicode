// The digest engine (#412): fetch → parse (RSS subset) → rank against the
// corpus-derived profile → dedup (corpus + posted-state) → format (mrkdwn).
// Deterministic and explainable: every pick carries its matched terms. The
// intelligence is the corpus, not a model.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArxivRss, buildProfile, scorePaper, rankDigest, formatDigest, type RssItem } from "../src/papers_digest.js";
import { foldCorpus } from "../src/papers.js";

// ── RSS subset (a real-shaped fixture: entities, CDATA, multi-line) ──────────
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>quant-ph</title>
<item><title>Rydberg blockade gates with improved fidelity</title>
<link>http://arxiv.org/abs/2608.99901</link>
<description>&lt;p&gt;We demonstrate two-qubit gates on neutral atom arrays using
optimized Rydberg blockade pulses and geometric phases.&lt;/p&gt;</description></item>
<item><title>A qLDPC code architecture for neutral atoms</title>
<link>http://arxiv.org/abs/2608.99902</link>
<description><![CDATA[<p>We present constant-overhead quantum LDPC codes
implemented with atom transport on rydberg arrays.</p>]]></description></item>
<item><title>Scattering amplitudes in N=4 SYM</title>
<link>http://arxiv.org/abs/2608.99903</link>
<description>&lt;p&gt;Purely mathematical results on integrability, no quantum
hardware content.</p>&lt;/p&gt;</description></item>
<item><title>Gravitational wave template banks</title>
<link>http://arxiv.org/abs/2608.99904</link>
<description>astro-ph cross-list about LIGO data analysis methods</description></item>
</channel></rss>`;

describe("parseArxivRss", () => {
  it("extracts id/title/abstract; unescapes entities; handles CDATA; tolerates multi-line", () => {
    const items = parseArxivRss(RSS);
    expect(items.map((i) => i.arxiv)).toEqual(["2608.99901", "2608.99902", "2608.99903", "2608.99904"]);
    expect(items[0]!.title).toBe("Rydberg blockade gates with improved fidelity");
    expect(items[0]!.abstract).toContain("two-qubit gates on neutral atom arrays");
    expect(items[0]!.abstract).not.toContain("&lt;");
    expect(items[1]!.abstract).toContain("constant-overhead quantum LDPC codes");
    expect(items[1]!.abstract).not.toContain("<![CDATA[");
  });
  it("malformed XML degrades to empty — the digest never crashes on a bad feed", () => {
    expect(parseArxivRss("<not-rss")).toEqual([]);
    expect(parseArxivRss("")).toEqual([]);
  });
});

// ── the corpus-derived profile ───────────────────────────────────────────────
let root: string;
let vaults: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "digest-"));
  vaults = join(root, "vaults");
  const mine = join(vaults, "mine");
  mkdirSync(join(mine, "papers"), { recursive: true });
  mkdirSync(join(root, "library"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function note(file: string, fm: string) {
  writeFileSync(join(vaults, "mine", "papers", file), `---\n${fm}\n---\n\n# t\n`);
}

function corpus() {
  return foldCorpus([vaults], join(root, "library"));
}

describe("buildProfile + scorePaper", () => {
  it("the profile IS the corpus: term weights from tags/systems, recent reads weigh more", () => {
    note("a.md", `type: paper\ntitle: "A"\nauthors: [X]\narxiv: "2101.00001"\ndate_read: 2026-08-01\nsystems: [rydberg]\ntags: [rydberg, blockade]`);
    note("b.md", `type: paper\ntitle: "B"\nauthors: [Y]\narxiv: "2101.00002"\ndate_read: 2026-07-01\nsystems: [rydberg]\ntags: [qldpc]`);
    note("c.md", `type: paper\ntitle: "C"\nauthors: [Z]\narxiv: "2101.00003"\ndate_read: 2024-01-01\nsystems: [nv-center]\ntags: [sensing]`);
    const p = buildProfile(corpus());
    expect(p.weight("rydberg")).toBeGreaterThan(p.weight("qldpc")); // appears in a fresher + more notes
    expect(p.weight("sensing")).toBeLessThan(p.weight("qldpc")); // stale note → decayed
    expect(p.weight("nv-center")).toBeGreaterThan(0);
    expect(p.weight("not-a-term")).toBe(0);
  });

  it("scoring is explainable: matched terms + where (title > abstract), score monotone in matches", () => {
    note("a.md", `type: paper\ntitle: "A"\nauthors: [X]\narxiv: "2101.00001"\ndate_read: 2026-08-01\nsystems: [rydberg]\ntags: [rydberg, qldpc, blockade]`);
    const p = buildProfile(corpus());
    const hit: RssItem = { arxiv: "2608.99901", title: "Rydberg blockade gates", abstract: "using qldpc ideas" };
    const miss: RssItem = { arxiv: "2608.99903", title: "Scattering amplitudes", abstract: "integrability" };
    const sHit = scorePaper(hit, p);
    const sMiss = scorePaper(miss, p);
    expect(sHit.score).toBeGreaterThan(0);
    expect(sMiss.score).toBe(0);
    expect(sHit.terms).toEqual(expect.arrayContaining(["rydberg", "blockade", "qldpc"]));
    // title match outweighs abstract-only match
    const titleHit = scorePaper({ arxiv: "t", title: "Rydberg things", abstract: "" }, p);
    const absHit = scorePaper({ arxiv: "t2", title: "Things", abstract: "rydberg appears here" }, p);
    expect(titleHit.score).toBeGreaterThan(absHit.score);
  });

  it("term matching respects word boundaries — 'ion' must not match 'question'", () => {
    note("a.md", `type: paper\ntitle: "A"\nauthors: [X]\narxiv: "2101.00001"\ndate_read: 2026-08-01\nsystems: [trapped-ion]\ntags: [ions]`);
    const p = buildProfile(corpus());
    const s = scorePaper({ arxiv: "t", title: "A question about superconductors", abstract: "mentioning ions once" }, p);
    expect(s.terms).toContain("ions");
    expect(s.terms).not.toContain("trapped-ion");
    expect(s.terms).not.toContain("ion"); // never a standalone match
  });
});

describe("rankDigest", () => {
  it("ranks by score, drops zeros, skips corpus identities and already-posted ids", () => {
    note("read.md", `type: paper\ntitle: "Already read"\nauthors: [X]\narxiv: "2608.99901"\ndate_read: 2026-08-01\nsystems: [rydberg]\ntags: [rydberg]`);
    const p = buildProfile(corpus());
    const items: RssItem[] = [
      { arxiv: "2608.99901", title: "Rydberg gates (already in corpus)", abstract: "rydberg" }, // corpus skip
      { arxiv: "2608.99902", title: "Rydberg qldpc architecture", abstract: "neutral atoms" }, // top
      { arxiv: "2608.99905", title: "Rydberg blockade improvements", abstract: "fidelity" }, // second
      { arxiv: "2608.99903", title: "Scattering amplitudes", abstract: "integrability" }, // zero → dropped
      { arxiv: "2608.99906", title: "Rydberg older pick", abstract: "posted yesterday" }, // state skip
    ];
    const r = rankDigest(items, p, corpus(), { posted: ["2608.99906"], top: 3 });
    expect(r.picks.map((x) => x.item.arxiv)).toEqual(["2608.99902", "2608.99905"]);
    expect(r.skipped.corpus).toEqual(["2608.99901"]);
    expect(r.skipped.posted).toEqual(["2608.99906"]);
    expect(r.dropped).toContain("2608.99903");
  });
});

describe("formatDigest", () => {
  it("renders mrkdyn: header with counts, numbered picks with links + why-lines", () => {
    const p = buildProfile({ papers: [], duplicates: [], invalid: [], orphanPdfs: [], recordsWithoutPdf: [] });
    void p;
    const r = rankDigest(
      [{ arxiv: "2608.99902", title: "A qLDPC architecture", abstract: "for neutral atoms" }],
      buildProfile(corpus()),
      corpus(),
      { posted: [], top: 3 },
    );
    void r;
    const text = formatDigest({
      feedName: "quant-ph",
      total: 39,
      picks: [
        { item: { arxiv: "2608.99902", title: "A qLDPC architecture", abstract: "" }, score: 9, terms: ["qldpc", "neutral-atoms"] },
        { item: { arxiv: "2608.99905", title: "Rydberg blockade", abstract: "" }, score: 6, terms: ["rydberg", "blockade"] },
      ],
      skipped: { corpus: [], posted: [] },
    });
    expect(text).toContain("*arXiv quant-ph picks for");
    expect(text).toContain("2 of 39 new");
    expect(text).toContain("http://arxiv.org/abs/2608.99902");
    expect(text).toContain("`qldpc`");
    expect(text).not.toContain("undefined");
  });
});
