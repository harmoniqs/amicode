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
