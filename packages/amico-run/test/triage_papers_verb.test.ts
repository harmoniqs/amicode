// `amico triage-papers` (amicode #1686, brain flywheel slice 7 — the arjev
// intake half): a relevance-high paper yields a claim-shaped hypothesis-seed
// proposal with a resolvable paper evidence pointer, linked to the affected
// problem card(s) when the paper's systems identity matches a card's platform.
// Dry-run by default; --apply writes the seed into a --out the caller names
// (default: the personal mount's claims candidates area). Idempotent:
// deterministic naming + bytes. The notturno pass receipt rides the distill
// chassis gates. Hermetic: fixture papers + problem cards + fake mounts.
//
// Run: `pnpm --filter @amicode/amico-run test triage`
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaim } from "@amicode/schema";
import { triagePapersVerb } from "../src/triage_papers_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { parseFrontmatter } from "../src/frontmatter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "triage");
const PAPERS = join(FIXTURES, "papers");
const PROBLEMS = join(FIXTURES, "problems");
const MITTEN = join(PAPERS, "paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");

/** A fixture notturno registry with the triage-papers job registered. */
function jobRegistry(dir: string, record: "always" | "acted" = "always", name = "registry.toml"): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      `[job.triage-papers]`,
      `workflow = "notturno-triage-papers.yml"`,
      `cadence  = "0 12 * * 1"`,
      `surface  = "mini"`,
      `warrant  = "stage"`,
      `delivers = ["vault-commit"]`,
      `record   = "${record}"`,
      `enabled  = true`,
      "",
    ].join("\n"),
  );
  return p;
}

/** A fake personal mount (the claims candidates area lives under amicode/). */
function fakeVaultRoot(): { root: string; mount: string } {
  const root = mkdtempSync(join(tmpdir(), "papers-vault-"));
  const mount = join(root, "vault-aaron");
  mkdirSync(join(mount, "amicode", "claims", "candidates"), { recursive: true });
  mkdirSync(join(mount, "papers"), { recursive: true });
  mkdirSync(join(mount, "amicode", "problems"), { recursive: true });
  writeFileSync(join(mount, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');
  return { root, mount };
}

describe("amico triage-papers — usage + resolution", () => {
  it("unknown flag → usage error, exit 64; missing dirs are honest 64s", async () => {
    expect((await triagePapersVerb(["--frob"], {})).code).toBe(64);
    const none = { AMICO_VAULTS_ROOT: join(tmpdir(), "papers-no-such-root") };
    expect((await triagePapersVerb([], none)).code).toBe(64); // no papers dir resolves
    const j = (await triagePapersVerb([], none)).json as { error: string };
    expect(j.error).toContain("--papers");
    const usage = ((await triagePapersVerb(["--frob"], {})).json as { usage: string }).usage;
    expect(usage).toContain("amico triage-papers");
  });

  it("is in SPINE_VERBS with the fields Verb requires", () => {
    const verb = SPINE_VERBS.find((v) => v.name === "triage-papers");
    expect(verb).toBeDefined();
    expect(verb!.summary.length).toBeGreaterThan(0);
    expect(verb!.generalizes.length).toBeGreaterThan(0);
    expect(verb!.slice.length).toBeGreaterThan(0);
  });
});

describe("amico triage-papers — the dry-run default", () => {
  it("a named relevance-high paper yields the seed as a report — nothing written", async () => {
    const out = mkdtempSync(join(tmpdir(), "papers-out-"));
    const r = await triagePapersVerb([MITTEN, "--problems", PROBLEMS, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.high).toBe(1);
    const seeds = j.seeds as { paper: string; matched: string[] }[];
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.matched.sort()).toEqual(["ccz-rydberg", "x-gate-rydberg-global"]);
    expect((j.would_write as Record<string, unknown>).seed).toContain("paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");
    expect(readdirSync(out)).toEqual([]);
  });

  it("a named paper below relevance-high is an honest no-op (named, exit 0)", async () => {
    const out = mkdtempSync(join(tmpdir(), "papers-out-"));
    const r = await triagePapersVerb([join(PAPERS, "paper-20260703-104000-strathearn-2018-tempo.md"), "--problems", PROBLEMS, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.seeds).toEqual([]);
    expect(String(j.note)).toContain("medium");
  });

  it("scan mode over the papers dir reads ONLY relevance-high notes; medium + malformed are named, never guessed", async () => {
    const out = mkdtempSync(join(tmpdir(), "papers-out-"));
    const r = await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.scanned).toBe(4);
    expect(j.high).toBe(2); // mitten (matches) + ge-crossbar (no card match)
    expect((j.no_match as unknown[]).length).toBe(1);
    expect((j.skipped as string[]).join(" ")).toContain("paper-20260914-malformed-no-identity.md");
    expect((j.skipped as string[]).join(" ")).toContain("paper-20260703-104000-strathearn-2018-tempo.md"); // medium — named honestly
  });
});

describe("amico triage-papers — apply: the seed files into the claim layer", () => {
  it("writes ONE claim-shaped seed per paper, linked to the matched problem cards, evidence-pointer resolvable", async () => {
    const out = mkdtempSync(join(tmpdir(), "papers-out-"));
    const r = await triagePapersVerb([MITTEN, "--problems", PROBLEMS, "--out", out, "--apply"], {});
    expect(r.code).toBe(0);
    const seedPath = join(out, basename(MITTEN));
    expect(existsSync(seedPath)).toBe(true);
    const raw = readFileSync(seedPath, "utf8");
    const fm = parseFrontmatter(raw);
    if (!fm.ok) throw new Error(fm.error);
    expect(validateClaim(fm.data).ok).toBe(true); // the ONE contract, green by construction
    expect(fm.data.evidence).toEqual(["paper/paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md"]);
    expect(raw).toContain("[[ccz-rydberg]]");
    expect(raw).toContain("[[x-gate-rydberg-global]]");
    expect(raw).toContain("[[paper-20260803-231156-bhardwaj-2026-mitten-qldpc]]");
    // the paper evidence pointer resolves against the intake it came from
    expect(existsSync(join(PAPERS, "paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md"))).toBe(true);
  });

  it("IDEMPOTENT: re-run overwrites its own seed with identical bytes; a no-match paper still writes nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "papers-out-"));
    await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", out, "--apply"], {});
    const bytes = (f: string) => readFileSync(join(out, f), "utf8");
    expect(readdirSync(out)).toEqual([basename(MITTEN)]); // ge-crossbar matched no card → no seed
    const first = bytes(basename(MITTEN));
    const r2 = await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", out, "--apply"], {});
    expect(r2.code).toBe(0);
    expect(bytes(basename(MITTEN))).toBe(first);
    expect(readdirSync(out)).toEqual([basename(MITTEN)]);
  });

  it("the default --out is the personal mount's claims candidates area (files INTO the claim layer)", async () => {
    const { root, mount } = fakeVaultRoot();
    const r = await triagePapersVerb([MITTEN, "--papers", PAPERS, "--problems", PROBLEMS], { AMICO_VAULTS_ROOT: root });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect((j.would_write as Record<string, unknown>).seed).toBe(
      join(mount, "amicode", "claims", "candidates", basename(MITTEN)),
    );
  });
});

describe("amico triage-papers — the notturno pass receipt", () => {
  it("apply + --registry/--dashboards files the receipt with the job's outcome line", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "papers-receipt-"));
    const dashboards = join(tmp, "dashboards");
    const r = await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", join(tmp, "seeds"), "--apply", "--registry", jobRegistry(tmp), "--dashboards", dashboards], {});
    expect(r.code).toBe(0);
    const journal = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(journal).toContain("triage-papers");
    expect(journal).toContain("seeded 1");
  });

  it("an unregistered job id is refused: exit 2, no receipt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "papers-receipt-"));
    const registry = join(tmp, "other.toml");
    writeFileSync(registry, '[job.other]\nworkflow = "w.yml"\ncadence = "* * *"\nsurface = "mini"\nwarrant = "stage"\nenabled = false\n');
    const r = await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", join(tmp, "seeds"), "--apply", "--registry", registry, "--dashboards", join(tmp, "dashboards")], {});
    expect(r.code).toBe(2);
    expect(existsSync(join(tmp, "dashboards", "scheduled-passes.md"))).toBe(false);
  });

  it("a deny-listed registry is refused loudly (exit 64)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "papers-deny-"));
    const registry = jobRegistry(tmp, "always", "notturno.toml");
    writeFileSync(join(tmp, "instance-deny-list.toml"), '[[deny]]\npath = "notturno.toml"\nreason = "instance config"\n');
    const r = await triagePapersVerb(["--papers", PAPERS, "--problems", PROBLEMS, "--out", join(tmp, "seeds"), "--apply", "--registry", registry, "--dashboards", join(tmp, "dashboards")], {});
    expect(r.code).toBe(64);
    const j = r.json as { error: string };
    expect(j.error).toContain("deny list");
  });

  it("record: acted + a pass that seeded nothing honestly skips the receipt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "papers-acted-"));
    const registry = jobRegistry(tmp, "acted");
    const dashboards = join(tmp, "dashboards");
    // a papers dir whose only note matches no card → nothing seeded
    const papers = join(tmp, "papers");
    mkdirSync(papers);
    writeFileSync(join(papers, "paper-20260914-borsoi-2022-ge-crossbar.md"), readFileSync(join(PAPERS, "paper-20260914-borsoi-2022-ge-crossbar.md"), "utf8"));
    const r = await triagePapersVerb(["--papers", papers, "--problems", PROBLEMS, "--out", join(tmp, "seeds"), "--apply", "--registry", registry, "--dashboards", dashboards], {});
    expect(r.code).toBe(0);
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
    const receipt = (r.json as Record<string, unknown>).receipt as Record<string, unknown>;
    expect(receipt.filed).toBe(false);
    expect(String(receipt.reason)).toContain("action only");
  });
});
