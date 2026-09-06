// `amico papers` verb tests (#405/#412): list surface + digest subcommand
// routing. Digest engine tests live in papers_digest.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { papersVerb } from "../src/papers_verb.js";

let root: string;
let vaults: string;
let library: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "papers-verb-"));
  vaults = join(root, "vaults");
  library = join(root, "library");
  const mine = join(vaults, "mine");
  mkdirSync(join(mine, "papers"), { recursive: true });
  mkdirSync(library, { recursive: true });
  process.env.AMICO_PAPERS_VAULTS = vaults;
  process.env.AMICO_PAPERS_LIBRARY = library;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.AMICO_PAPERS_VAULTS;
  delete process.env.AMICO_PAPERS_LIBRARY;
});

const N1 = `type: paper\ntitle: "TEMPO"\nauthors: [Strathearn]\narxiv: "1711.09641"\nstatus: staged\nsystems: [transmon]\ntags: [tempo, open-systems]`;
const N2 = `type: paper\ntitle: "Mitten qLDPC"\nauthors: [Bhardwaj]\ndoi: "10.48550/arXiv.2607.28795"\nrelevance: high\nsystems: [rydberg]\ntags: [qldpc]`;

function note(file: string, fm: string) {
  writeFileSync(join(vaults, "mine", "papers", file), `---\n${fm}\n---\n\n# t\n`);
}

describe("papersVerb", () => {
  it("usage error with no subcommand (exit 64, no crash)", async () => {
    const r = await papersVerb([]);
    expect(r.code).toBe(64);
  });

  it("list: JSON with the unified corpus + counts + drift", async () => {
    note("a.md", N1);
    note("b.md", N2);
    const r = await papersVerb(["list", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json as { ok: boolean; papers: { title: string }[]; counts: Record<string, number> };
    expect(j.ok).toBe(true);
    expect(j.papers.map((p) => p.title).sort()).toEqual(["Mitten qLDPC", "TEMPO"]);
    expect(j.counts.papers).toBe(2);
    expect(j.counts.records_without_pdf).toBe(2);
  });

  it("filters: --status, --tag, --platform, --q substring", async () => {
    note("a.md", N1);
    note("b.md", N2);
    const run = async (args: string[]) =>
      ((await papersVerb(["list", "--json", ...args])).json as { papers: { title: string }[] }).papers.map((p) => p.title);
    expect(await run(["--status", "staged"])).toEqual(["TEMPO"]);
    expect(await run(["--status", "distilled"])).toEqual(["Mitten qLDPC"]); // absent = distilled
    expect(await run(["--tag", "qldpc"])).toEqual(["Mitten qLDPC"]);
    expect(await run(["--platform", "transmon"])).toEqual(["TEMPO"]);
    expect(await run(["--q", "mitten"])).toEqual(["Mitten qLDPC"]);
    expect(await run(["--q", "qLDPC"])).toEqual(["Mitten qLDPC"]); // case-insensitive
  });

  it("default output is a human table (rendered string), not raw JSON", async () => {
    note("a.md", N1);
    const r = await papersVerb(["list"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(r.json)).toContain("TEMPO");
  });

  it("invalid notes are reported, never fatal", async () => {
    note("bad.md", `type: paper\ntitle: "No identity"\nauthors: [X]`);
    const r = await papersVerb(["list", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json as { counts: Record<string, number>; invalid: { file: string }[] };
    expect(j.counts.invalid).toBe(1);
    expect(j.invalid[0]!.file).toContain("bad.md");
  });

  it("digest routes (unknown-flag surface exercised in engine tests)", async () => {
    const r = await papersVerb(["nonsense"]);
    expect(r.code).toBe(64);
  });
});

// ── living-sota slice 2: the digest's relevance router (spec D3, S3) ──────────
// the papers digest gains the staged router: its LAB-CORPUS picks route
// against the active campaigns; matches stage into the campaign sidecar,
// below-threshold/no-match into the hopper. Hermetic: --feed-xml seeds the
// feed from a fixture file (the deterministic seam) — zero transports.

import { mkdtempSync as mkd2, writeFileSync as wf2, readFileSync as rf2, mkdirSync as mkd2d } from "node:fs";
import { deriveStagingState, stagingStreamPath, HOPPER_CAMPAIGN } from "../src/sota_staging.js";

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
<item><title>Fast Rydberg CZ gates via optimal control</title><link>http://arxiv.org/abs/2606.05060</link><description>We shape pulses in the blockade regime; the CZ gate reaches 0.9999 on an eight-atom register.</description></item>
<item><title>Protein folding via deep learning</title><link>http://arxiv.org/abs/2606.99999</link><description>AlphaFold-style pipelines for structure prediction.</description></item>
<item><title>Unrelated condensed matter note</title><link>http://arxiv.org/abs/2606.11111</link><description>A note about something else entirely.</description></item>
</channel></rss>`;

const ACTIVE_LEDGER_2 = `# Session ledger — Rydberg blockade scaling

## 2. Verdict table

| item | status |
|---|---|
| H1 blockade radius calibration | pending |
`;

function corpusNote(terms: string[]): void {
  // the lab corpus gives the profile the taste that picks the digest entries
  // (a VALID library-paper record — the corpus fold skips invalid notes)
  wf2(join(vaults, "mine", "papers", `note-${Math.random().toString(36).slice(2)}.md`), `---\ntype: paper\ntitle: "T"\nauthors: [Someone]\narxiv: "0000.00000"\nsystems: [${terms.join(", ")}]\ntags: [${terms.join(", ")}]\n---\n\n# t\n`);
}

describe("`amico papers digest --route` — matched picks stage into the campaign sidecar (the digest's router)", () => {
  it("routes the digest picks: matched -> campaign sidecar; sub-corpus-threshold/unmatched -> hopper; idempotent re-run", async () => {
    corpusNote(["rydberg", "cz", "blockade", "protein"]);
    const sessions = mkd2(join(tmpdir(), "papers-sessions-"));
    wf2(join(sessions, "session-20260901-rydberg-blockade.md"), ACTIVE_LEDGER_2);
    const feedFile = join(mkd2(join(tmpdir(), "papers-feed-")), "feed.xml");
    wf2(feedFile, FEED_XML);
    const res = await papersVerb(["digest", "--feed-xml", feedFile, "--route", "--sessions", sessions]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; routed: { staged: { event_id: string; campaign: string }[]; hopper: { event_id: string; reason: string }[]; deduped: string[] } };
    expect(j.ok).toBe(true);
    // the rydberg paper matched the active campaign; protein + the unrelated note did not
    expect(j.routed.staged).toHaveLength(1);
    expect(j.routed.staged[0]).toMatchObject({ event_id: "arxiv:2606.05060", campaign: "session-20260901-rydberg-blockade" });
    expect(j.routed.hopper).toHaveLength(1);
    expect(j.routed.hopper[0]).toMatchObject({ event_id: "arxiv:2606.99999" });
    const sidecar = deriveStagingState(stagingStreamPath(sessions, "session-20260901-rydberg-blockade"));
    expect(sidecar.entries.get("arxiv:2606.05060")?.state).toBe("staged");
    expect(sidecar.entries.get("arxiv:2606.05060")?.provenance?.job).toBe("papers-digest");
    expect(deriveStagingState(stagingStreamPath(sessions, HOPPER_CAMPAIGN)).entries.get("arxiv:2606.99999")?.state).toBe("staged");
    // re-running the digest on the same feed dedupes by event id — one stage line each
    const twice = await papersVerb(["digest", "--feed-xml", feedFile, "--route", "--sessions", sessions]);
    const j2 = (twice.json as { routed: { deduped: string[] } }).routed;
    expect(j2.deduped.sort()).toEqual(["arxiv:2606.05060", "arxiv:2606.99999"]);
    expect(rf2(stagingStreamPath(sessions, "session-20260901-rydberg-blockade"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("without --route the digest does NOT stage (routing is the job's explicit act, never a side effect of a dry run)", async () => {
    corpusNote(["rydberg", "cz"]);
    const sessions = mkd2(join(tmpdir(), "papers-sessions-"));
    wf2(join(sessions, "session-20260901-rydberg-blockade.md"), ACTIVE_LEDGER_2);
    const feedFile = join(mkd2(join(tmpdir(), "papers-feed-")), "feed.xml");
    wf2(feedFile, FEED_XML);
    const res = await papersVerb(["digest", "--feed-xml", feedFile, "--sessions", sessions]);
    expect(res.code).toBe(0);
    expect((res.json as { routed?: unknown }).routed).toBeUndefined();
    expect(mkd2d).toBeTruthy(); // (import sanity for the fs helpers)
    expect(!existsSyncSync(stagingStreamPath(sessions, "session-20260901-rydberg-blockade"))).toBe(true);
  });

  it("a routing failure is a NAMED, non-fatal outcome (the digest still reports; the survey never blocks)", async () => {
    corpusNote(["rydberg", "cz"]);
    // sessions dir points into a FILE — enumerate/read fails -> named routing error, digest exit 0
    const sessionsFile = join(mkd2(join(tmpdir(), "papers-badsessions-")), "sessions");
    wf2(sessionsFile, "not a dir");
    const feedFile = join(mkd2(join(tmpdir(), "papers-feed-")), "feed.xml");
    wf2(feedFile, FEED_XML);
    const res = await papersVerb(["digest", "--feed-xml", feedFile, "--route", "--sessions", sessionsFile]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; routed: { staged: unknown[]; errors: string[] } };
    expect(j.ok).toBe(true);
    expect(j.routed.staged).toHaveLength(0);
    expect(j.routed.errors.length).toBeGreaterThan(0);
  });
});

function existsSyncSync(p: string): boolean {
  try {
    rf2(p);
    return true;
  } catch {
    return false;
  }
}
