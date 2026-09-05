// sota_review_skill.test.ts — the sota-review skill's lint (#820, spec
// spec-20260905-103000 living-sota D1 / S1): ONE public skill carrying BOTH
// lenses, with the web-search recipe's rules LINT-PINNED — the required
// rules grepped IN, the scraping patterns grepped OUT, and the recipe's
// machinery (queue, cache, canonical-repos-only) pinned against the real
// verb surface in amico-run. The content lens (blocklist + internal path
// shapes, the #809 discipline) applies to this new public skill exactly as
// it does to the workflow set — one discipline, every public surface.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const SKILL = join(EXT, "skills", "sota-review", "SKILL.md");
const AMICO_RUN = join(EXT, "..", "amico-run");

const skill = readFileSync(SKILL, "utf8");
// prose assertions match on whitespace-NORMALIZED text (markdown reflows —
// a lint that breaks on line wrapping is a lint someone "fixes" by
// re-wrapping the skill); literal pins (commands, URLs) match the raw text.
const flat = skill.replace(/\s+/g, " ");

// ── the recipe's rules, grepped IN (the skill is the loop's instruction — ────
//    if the rule isn't in the text, the rule doesn't exist)

describe("the sota-review skill carries both lenses with the recipe verbatim (#820 D1)", () => {
  it("ships with public surface + revision frontmatter (the shipping tiers of record)", () => {
    expect(existsSync(SKILL)).toBe(true);
    const fm = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(fm).toMatch(/^surface:\s*public\b/m);
    expect(fm).toMatch(/^source:\s*\S/m);
    expect(fm).toMatch(/^revision:\s*[1-9]\d*\s*$/m);
  });

  it("rule 1 — vault/repo grep FIRST: the step precedes any network in the text", () => {
    expect(flat).toMatch(/vault\/repo grep FIRST/i);
    expect(skill).toMatch(/grep -rn -i/);
    const grepIdx = skill.search(/Vault\/repo grep FIRST/i);
    const arxivIdx = skill.search(/arXiv API over HTTPS/);
    expect(grepIdx).toBeGreaterThanOrEqual(0);
    expect(arxivIdx).toBeGreaterThan(grepIdx); // step 1 precedes step 2 — in the TEXT, in order
  });

  it("rule 2 — the arXiv API over HTTPS, with the http:// gotcha NAMED", () => {
    expect(skill).toContain("https://export.arxiv.org/api/query");
    expect(skill).toMatch(/http:\/\//); // the gotcha is named
    expect(skill).toMatch(/silently hangs/); // ...with its failure mode, verbatim from the recipe
  });

  it("rule 3 — never search-engine scraping: the ban is explicit and the targets are named", () => {
    expect(flat).toMatch(/Never search-engine scraping/i);
    expect(skill).toMatch(/Bing or Google HTML/);
    expect(flat).toMatch(/never scraping|never fetch\s+them/i);
  });

  it("the queue discipline — one fetcher, one serialized queue; the named outcome, the disclosed alternative, and the KNOWN LIMIT named", () => {
    expect(flat).toMatch(/serialized queue|one query queue/i);
    expect(flat).toMatch(/per-host lock serializes nothing/i); // the fleet-wide invariant, stated
    expect(skill).toMatch(/queue-timeout/); // the named outcome
    expect(flat).toMatch(/never block the loop|the loop was never blocked/i); // the survey never blocks
    expect(skill).toMatch(/via: cache/); // cache reads are honest about being cache reads
    // A2 (review fold on #828): the mutual-exclusion limit is NAMED, not hidden
    expect(flat).toMatch(/known limit/i);
    expect(flat).toMatch(/best-effort/i);
    expect(flat).toMatch(/atomic per host/i);
    expect(flat).toMatch(/duplicate fetch/); // the bounded damage, named
  });

  it("the codebase lens — the GitHub API against CANONICAL repos, never a local fork checkout", () => {
    expect(flat).toMatch(/never a local fork checkout/i);
    expect(flat).toMatch(/canonical repos/i);
    expect(skill).toMatch(/amico sota codebase/);
  });

  it("the registry is DATA — adding a repo is a data edit; retire-or-confirm is the human decision", () => {
    expect(flat).toMatch(/data edit, never code/i);
    expect(flat).toMatch(/validator-checked TOML/i);
    expect(skill).toMatch(/retire-or-confirm/);
    expect(flat).toMatch(/fails LOUDLY/i);
  });

  it("PI-register briefs — cited, provenance-stamped, the anomaly line pinned", () => {
    expect(flat).toMatch(/provenance-stamped/i);
    expect(skill).toContain("scan returned nothing — anomalous"); // the floor's render, verbatim
    expect(flat).toMatch(/never "nothing new"|never says "nothing new"/i); // the silent-empty failure mode, banned verbatim
  });

  it("the skill drives the REAL verb surface (the commands exist in the amico-run verb registry)", () => {
    const verbs = readFileSync(join(AMICO_RUN, "src", "verbs.ts"), "utf8");
    expect(verbs).toMatch(/name: "sota"/);
    expect(skill).toMatch(/amico sota papers --query/);
    expect(skill).toMatch(/amico sota codebase/);
  });

  it("honest scope — this slice fetches and reports (staging is a named later layer)", () => {
    expect(flat).toMatch(/fetches and reports/i);
    expect(flat).toMatch(/later layer|later slices/i);
  });
});

// ── the scraping patterns, grepped OUT (a fetch target the recipe bans ──────
//    must appear NOWHERE — not in the skill, not in the lens code, not in the
//    verb; the ban is structural, not advisory)

describe("scraping patterns are banned by grep (#820 S1 — the recipe's rules, mechanically)", () => {
  const SCRAPING_URL_PATTERNS = [
    /bing\.com/i,
    /google\.com\/search/i,
    /duckduckgo\.com/i,
    /search\.yahoo\./i,
  ];
  const SURFACES: Record<string, string> = {
    "the skill": skill,
    "the papers lens (sota_papers.ts)": readFileSync(join(AMICO_RUN, "src", "sota_papers.ts"), "utf8"),
    "the codebase lens (sota_codebase.ts)": readFileSync(join(AMICO_RUN, "src", "sota_codebase.ts"), "utf8"),
    "the fetch seam (sota_fetch.ts)": readFileSync(join(AMICO_RUN, "src", "sota_fetch.ts"), "utf8"),
    "the verb (sota_verb.ts)": readFileSync(join(AMICO_RUN, "src", "sota_verb.ts"), "utf8"),
  };

  for (const [name, text] of Object.entries(SURFACES)) {
    for (const pat of SCRAPING_URL_PATTERNS) {
      it(`${name} carries no scraper-target URL (${pat})`, () => {
        expect(pat.test(text), `${name} must not contain ${pat}`).toBe(false);
      });
    }
  }

  it("the only network endpoints in the lens code are the sanctioned APIs (arXiv export over https; GitHub API)", () => {
    const lensCode = [
      readFileSync(join(AMICO_RUN, "src", "sota_papers.ts"), "utf8"),
      readFileSync(join(AMICO_RUN, "src", "sota_codebase.ts"), "utf8"),
    ].join("\n");
    const httpsHosts = [...lensCode.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    const sanctioned = new Set(["export.arxiv.org", "arxiv.org", "api.github.com", "github.com"]);
    const offenders = httpsHosts.filter((h) => !sanctioned.has(h));
    expect(offenders, `unsanctioned https hosts in the lenses: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the skill's prose may NAME the banned engines but never as a fetch target — no curl/fetch + engine pairing", () => {
    expect(/(curl|fetch|wget)[^\n]*bing/i.test(skill)).toBe(false);
    expect(/(curl|fetch|wget)[^\n]*google/i.test(skill)).toBe(false);
  });
});

// ── the #809 content lens, applied to the new public surface (one ───────────
//    discipline, every public skill)

describe("content lens — the sota-review skill carries no proprietary or internal-machine content (#809 discipline)", () => {
  const BLOCKLIST = JSON.parse(readFileSync(join(EXT, "protocol-blocklist.json"), "utf8")) as {
    proprietary_strings: string[];
    banned_names: string[];
  };

  it("no blocklisted proprietary string or banned name", () => {
    for (const s of [...BLOCKLIST.proprietary_strings, ...BLOCKLIST.banned_names]) {
      expect(skill.toLowerCase(), `must not contain "${s}" on the public surface`).not.toContain(s.toLowerCase());
    }
  });

  it("no internal-machine path shape (mount paths, tool state trees, private layouts)", () => {
    const INTERNAL_PATH_SHAPES = ["/home/", "/users/", "~/armonia", "~/.amico", ".amico/vaults", "armonissima", "repos/amico"];
    for (const shape of INTERNAL_PATH_SHAPES) {
      expect(skill.toLowerCase(), `must not carry the internal path shape "${shape}"`).not.toContain(shape.toLowerCase());
    }
  });
});
