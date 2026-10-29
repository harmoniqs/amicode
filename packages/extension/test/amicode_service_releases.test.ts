// #2001 — the What's-new landing page's content service. docs/releases/<v>.md
// (YAML front matter {version, date, highlights, links} + optional body) is
// copied into the VSIX at build; GET /amicode/releases?since=<v> reads the
// bundled files and answers the cards to show, newest first, plus the
// "new for you" model arrivals from the reachability cache's first_ok_at.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  loadReleaseCards,
  newForYouModels,
  parseReleaseFile,
  releaseBaselineMs,
  releasesResponse,
  selectReleaseCards,
  type ReleaseCard,
} from "../src/amicode_service/releases";

const md = (version: string, date: string, extra = "") =>
  [
    "---",
    `version: ${version}`,
    `date: ${date}`,
    "highlights:",
    `  - title: Headline of ${version}`,
    "    body: A user-facing sentence.",
    "links:",
    `  notes: https://github.com/harmoniqs/amicode/releases/tag/v${version}`,
    "---",
    "",
    `Body of ${version}.${extra}`,
    "",
  ].join("\n");

function releasesDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "amc-2001-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const card = (version: string, date = "2026-10-01"): ReleaseCard => ({
  version,
  date,
  highlights: [{ title: version, body: "b" }],
  links: { notes: null },
  body: "",
});

describe("compareVersions", () => {
  it("orders semver cores numerically, prereleases below their release", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.3.10")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("v0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.4.0-lane.1", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.3.11-lane.1", "0.3.10")).toBeGreaterThan(0);
  });
});

describe("version range selection", () => {
  const all = [card("0.4.0"), card("0.3.10"), card("0.3.9")];

  it("0.3.10 → 0.4.0 shows one card", () => {
    const s = selectReleaseCards(all, { since: "0.3.10", current: "0.4.0" });
    expect(s.show).toBe(true);
    expect(s.welcome).toBe(false);
    expect(s.cards.map((c) => c.version)).toEqual(["0.4.0"]);
  });

  it("0.3.9 → 0.4.0 shows two, newest first", () => {
    const s = selectReleaseCards([card("0.3.10"), card("0.3.9"), card("0.4.0")], { since: "0.3.9", current: "0.4.0" });
    expect(s.cards.map((c) => c.version)).toEqual(["0.4.0", "0.3.10"]);
  });

  it("same version → nothing (the second open shows nothing)", () => {
    const s = selectReleaseCards(all, { since: "0.4.0", current: "0.4.0" });
    expect(s.show).toBe(false);
    expect(s.cards).toEqual([]);
    // a lane prerelease build re-opened at its own version also shows nothing
    expect(selectReleaseCards(all, { since: "0.3.11-lane.1", current: "0.3.11-lane.1" }).show).toBe(false);
  });

  it("fresh install (no last-seen) → a short welcome, not the full history", () => {
    const s = selectReleaseCards(all, { since: null, current: "0.4.0" });
    expect(s.show).toBe(true);
    expect(s.welcome).toBe(true);
    expect(s.cards).toEqual([]);
  });

  it("cards newer than the running build are not shown — except on a lane prerelease (it previews its notes)", () => {
    expect(selectReleaseCards(all, { since: "0.3.9", current: "0.3.10" }).cards.map((c) => c.version)).toEqual(["0.3.10"]);
    expect(selectReleaseCards(all, { since: "0.3.10", current: "0.3.11-lane.1" }).cards.map((c) => c.version)).toEqual(["0.4.0"]);
  });
});

describe("front-matter parsing", () => {
  it("parses version, date, highlights, links and the markdown body", () => {
    const c = parseReleaseFile(md("0.4.0", "2026-10-29"));
    expect(c).toEqual({
      version: "0.4.0",
      date: "2026-10-29",
      highlights: [{ title: "Headline of 0.4.0", body: "A user-facing sentence." }],
      links: { notes: "https://github.com/harmoniqs/amicode/releases/tag/v0.4.0" },
      body: "Body of 0.4.0.",
    });
  });

  it("malformed files are rejected (no front matter, bad YAML, no version, no highlights)", () => {
    expect(parseReleaseFile("# just markdown\n")).toBeUndefined();
    expect(parseReleaseFile("---\nversion: [unterminated\n---\n")).toBeUndefined();
    expect(parseReleaseFile("---\ndate: 2026-10-29\nhighlights: []\n---\n")).toBeUndefined();
    expect(parseReleaseFile("---\nversion: banana\ndate: 2026-10-29\nhighlights: []\n---\n")).toBeUndefined();
    expect(parseReleaseFile("---\nversion: 0.4.0\ndate: 2026-10-29\nhighlights: nope\n---\n")).toBeUndefined();
  });

  it("loadReleaseCards skips a malformed file and non-.md files, newest first", () => {
    const dir = releasesDir({
      "0.3.10.md": md("0.3.10", "2026-10-27"),
      "0.4.0.md": md("0.4.0", "2026-10-29"),
      "0.3.11.md": "---\nversion: [broken\n---\n",
      "README.txt": "not a release",
    });
    expect(loadReleaseCards(dir).map((c) => c.version)).toEqual(["0.4.0", "0.3.10"]);
    expect(loadReleaseCards(join(dir, "missing"))).toEqual([]);
  });

  it("the committed docs/releases files all parse (the bundled notes are real)", () => {
    const cards = loadReleaseCards(resolve(__dirname, "../../../docs/releases"));
    expect(cards.map((c) => c.version)).toEqual(expect.arrayContaining(["0.4.0", "0.3.10"]));
    for (const c of cards) {
      expect(c.highlights.length).toBeGreaterThan(0);
      expect(c.links.notes).toMatch(/^https:\/\/github\.com\/harmoniqs\/amicode\/releases\/tag\/v/);
    }
  });
});

describe("new for you — model arrivals since the last-seen version", () => {
  const rows = [
    { provider: "anthropic", model: "claude-new", status: "ok", first_ok_at: Date.parse("2026-10-28T12:00:00Z") },
    { provider: "anthropic", model: "claude-old", status: "ok", first_ok_at: 0 },
    { provider: "openai", model: "gpt-dead", status: "denied", first_ok_at: Date.parse("2026-10-28T12:00:00Z") },
    { provider: "openai", model: "gpt-unknown", status: "ok", first_ok_at: null },
    { provider: "openai", model: "gpt-before", status: "ok", first_ok_at: Date.parse("2026-10-20T00:00:00Z") },
  ];

  it("lists only models that are ok NOW and first seen ok after the baseline", () => {
    expect(newForYouModels(rows, Date.parse("2026-10-27T00:00:00Z"))).toEqual([
      { provider: "anthropic", model: "claude-new", first_ok_at: Date.parse("2026-10-28T12:00:00Z") },
    ]);
  });

  it("no baseline → no section (never the whole catalog)", () => {
    expect(newForYouModels(rows, null)).toEqual([]);
  });

  it("the baseline is the last-seen version's release date (or the newest release at or below it)", () => {
    const cards = [card("0.4.0", "2026-10-29"), card("0.3.10", "2026-10-27")];
    expect(releaseBaselineMs(cards, "0.3.10")).toBe(Date.parse("2026-10-27T00:00:00Z"));
    expect(releaseBaselineMs(cards, "0.3.10-lane.4")).toBeNull();
    expect(releaseBaselineMs(cards, "0.3.11-lane.1")).toBe(Date.parse("2026-10-27T00:00:00Z"));
    expect(releaseBaselineMs(cards, null)).toBeNull();
  });
});

describe("GET /amicode/releases", () => {
  const files = { "0.3.10.md": md("0.3.10", "2026-10-27"), "0.4.0.md": md("0.4.0", "2026-10-29"), "bad.md": "nope" };
  const reachability = async () => ({
    models: [{ provider: "anthropic", model: "claude-new", status: "ok", first_ok_at: Date.parse("2026-10-28T00:00:00Z") }],
  });

  it("the response body: current, the cards newest first, new_for_you", async () => {
    const dir = releasesDir(files);
    const body = JSON.parse(await releasesResponse({ since: "0.3.9" }, { dir, version: "0.4.0", reachability }));
    expect(body).toMatchObject({ ok: true, current: "0.4.0", since: "0.3.9", show: true, welcome: false, error: null });
    expect(body.cards.map((c: ReleaseCard) => c.version)).toEqual(["0.4.0", "0.3.10"]);
    // 0.3.9 has no bundled release → no baseline → no arrivals section
    expect(body.new_for_you.models).toEqual([]);

    const one = JSON.parse(await releasesResponse({ since: "0.3.10" }, { dir, version: "0.4.0", reachability }));
    expect(one.cards.map((c: ReleaseCard) => c.version)).toEqual(["0.4.0"]);
    expect(one.new_for_you.models).toEqual([
      { provider: "anthropic", model: "claude-new", first_ok_at: Date.parse("2026-10-28T00:00:00Z") },
    ]);
  });

  it("an unreadable reachability cache degrades to no arrivals (the page still renders)", async () => {
    const dir = releasesDir(files);
    const body = JSON.parse(
      await releasesResponse({ since: "0.3.10" }, { dir, version: "0.4.0", reachability: async () => { throw new Error("x"); } }),
    );
    expect(body.ok).toBe(true);
    expect(body.new_for_you.models).toEqual([]);
  });

  it("a malformed since is a named bad_request (never echoed)", async () => {
    const body = JSON.parse(await releasesResponse({ since: "<script>" }, { dir: releasesDir(files), version: "0.4.0" }));
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^bad_request: /);
    expect(body.error).not.toContain("<script>");
  });

  it("is served by the booted amicode service from the bundled dir (works offline)", async () => {
    const { createAmicodeService } = await import("../src/amicode_service");
    const dir = releasesDir(files);
    const opsDir = mkdtempSync(join(tmpdir(), "amc-2001-ops-"));
    mkdirSync(opsDir, { recursive: true });
    const service = createAmicodeService({
      releases: { dir, version: "0.4.0" },
      modelReachability: { file: join(opsDir, "model-reachability.json"), schedulerIntervalMs: 0 },
    });
    const url = await service.start();
    try {
      const res = await fetch(new URL("/amicode/releases?since=0.3.10", url), { headers: { Authorization: service.authHeader } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; cards: ReleaseCard[]; current: string };
      expect(body.ok).toBe(true);
      expect(body.current).toBe("0.4.0");
      expect(body.cards.map((c) => c.version)).toEqual(["0.4.0"]);
      const fresh = (await (await fetch(new URL("/amicode/releases", url), { headers: { Authorization: service.authHeader } })).json()) as {
        welcome: boolean;
      };
      expect(fresh.welcome).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("the default version is the extension's own package.json version", async () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string };
    const body = JSON.parse(await releasesResponse({ since: pkg.version }, { dir: releasesDir(files) }));
    expect(body.current).toBe(pkg.version);
    expect(body.show).toBe(false);
  });
});
