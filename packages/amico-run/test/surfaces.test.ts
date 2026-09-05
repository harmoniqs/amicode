// surfaces.test.ts — doctor v2's verdict-matrix fixture suite (#525, spec D1 +
// Measurement Protocol). Fully hermetic: every fixture injects temp roots — fake
// binaries are shell scripts printing PINNED version strings, sidecars are
// fabricated next to them, git fixtures are real repos with PINNED commit dates
// (env overrides at setup) whose "remotes" are local bare repos (or dead paths
// for the unreachable-remote cells). The real ~/.amico, ~/.vscode and
// ~/armonia are NEVER touched. The world builder lives in test/helpers.ts
// (shared with the doctor unit + CLI tests).
//
// Date determinism (the spec's rule): current cells pin BOTH sides — fake
// binaries print FAR-FUTURE build dates (2099…), git commits carry FAR-PAST
// pinned dates (2026-08-01); stale cells flip one side. No mtime is ever read.
//
// Authorship (the house split): implementer authored these cells; the reviewer
// adds adversarial variants — recorded in test/fixtures/surfaces/README.md.
import { describe, test, expect } from "vitest";
import { writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { surfaceInventory, canonicalJson, type SurfaceContext, type SurfaceRecord } from "../src/surfaces.js";
import { loadDoctorSchema, validateDoctorReport } from "../src/doctor_schema.js";
import {
  buildDoctorWorld,
  ctxForWorld,
  cleanupTracked,
  fixtureGit,
  bumpExtensionOnRemote,
  addReleaseTagOnRemote,
  advanceRegistryOnRemote,
  fakeBin,
  sha256File,
  LIVE_PLATFORM,
  GIT_COMMIT_DATE,
  FUTURE_BUILD,
  PAST_BUILD,
  type DoctorWorld,
} from "./helpers.js";
import { processStartTimeToken } from "@amicode/schema";

const cleanup = cleanupTracked;

const bySurface = (report: { surfaces: SurfaceRecord[] }, name: string): SurfaceRecord =>
  report.surfaces.find((r) => r.surface === name)!;

// ── the matrix ───────────────────────────────────────────────────────────────
describe("doctor v2 surface inventory — current cells", () => {
  test("current world: all six surfaces current, records complete and ordered", async () => {
    const w = buildDoctorWorld();
    const report = await surfaceInventory(ctxForWorld(w));
    expect(report.surfaces.map((r) => [r.surface, r.verdict])).toEqual([
      ["server-binary", "current"],
      ["extension", "current"],
      ["vendored-binary", "current"],
      ["staged-skills", "current"],
      ["agent-cards-global", "current"],
      ["agent-cards-staging", "current"],
    ]);
    for (const r of report.surfaces) {
      expect(r.version, `${r.surface} version`).toBeTruthy();
      expect(r.source_version, `${r.surface} source_version`).toBeTruthy();
      expect(r.evidence.length, `${r.surface} evidence`).toBeGreaterThan(0);
    }
    // server-binary: frozen version observed, source = fetched HEAD commit date
    const sb = bySurface(report, "server-binary");
    expect(sb.version).toBe(FUTURE_BUILD);
    expect(sb.evidence.join(" ")).toMatch(/sha256/);
    // extension: version-SORTED newest (0.2.6), never mtime (0.2.4 dir is newer)
    const ext = bySurface(report, "extension");
    expect(ext.version).toContain("0.2.6");
    expect(ext.source_version).toBe("0.2.6");
    // vendored: printed version == latest release tag base
    const vb = bySurface(report, "vendored-binary");
    expect(vb.version).toBe("1.18.10");
    expect(vb.source_version).toBe("1.18.10");
    cleanup();
  });
});

describe("doctor v2 surface inventory — stale cells", () => {
  test("server-binary stale (version): far-past build date < pinned HEAD commit date", async () => {
    const w = buildDoctorWorld({ frozenVersion: PAST_BUILD }); // build 2026-01-01 < HEAD 2026-08-01
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.version).toBe(PAST_BUILD);
    expect(sb.evidence.join(" ")).toMatch(/build date .* < HEAD commit date/);
    cleanup();
  });

  test("server-binary stale (restart pending): running binary sha ≠ frozen sha", async () => {
    // different bytes (one-digit-different version line) → different sha
    const w = buildDoctorWorld({ runningVersion: "0.0.0-local/amicode-209901010001" });
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.evidence.join(" ")).toMatch(/running .* sha256 .* ≠ frozen sha256 .* \(restart pending\)/);
    cleanup();
  });

  test("server-binary stale (server-down): absent process is stale with server-down evidence", async () => {
    const w = buildDoctorWorld({ runningVersion: null });
    const report = await surfaceInventory(ctxForWorld(w, { discoverRunning: async () => null }));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.evidence.join(" ")).toMatch(/server-down: no running opencode serve process/);
    cleanup();
  });

  test("extension stale: installed 0.2.6 behind fetched origin/main 0.2.7", async () => {
    const w = buildDoctorWorld();
    bumpExtensionOnRemote(w.remoteAmicode, "0.2.7");
    const report = await surfaceInventory(ctxForWorld(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("stale");
    expect(ext.version).toContain("0.2.6");
    expect(ext.source_version).toBe("0.2.7");
    expect(ext.evidence.join(" ")).toMatch(/behind/);
    cleanup();
  });

  test("vendored-binary stale: printed 1.18.10 behind new release tag base 1.18.12", async () => {
    const w = buildDoctorWorld();
    addReleaseTagOnRemote(w.remoteFork, "v1.18.12-amicode.1");
    const report = await surfaceInventory(ctxForWorld(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("stale");
    expect(vb.version).toBe("1.18.10");
    expect(vb.source_version).toBe("1.18.12");
    expect(vb.evidence.join(" ")).toMatch(/behind/);
    cleanup();
  });

  test("staged-skills stale: per-skill digest diff (changed skill named in evidence)", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.staging, "skills", "beta", "SKILL.md"), "# beta\nDRIFTED staged copy\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("stale");
    expect(sk.evidence.join(" ")).toMatch(/skill beta changed/);
    expect(sk.evidence.join(" ")).not.toMatch(/skill alpha/); // alpha still byte-matches
    cleanup();
  });

  test("agent-cards-global stale: deployed card tampered (per-card digest diff)", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.config, "agents", "autodev.md"), "---\nmode: autodev\n---\n# TAMPERED\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    expect(g.evidence.join(" ")).toMatch(/card autodev\.md changed/);
    const st = bySurface(report, "agent-cards-staging");
    expect(st.verdict).toBe("current"); // the OTHER deployment is unaffected
    cleanup();
  });

  test("agent-cards-staging stale: source present + receipt missing is stale (digest diff governs, receipt secondary)", async () => {
    const w = buildDoctorWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json"));
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict).toBe("stale");
      expect(r.evidence.join(" ")).toMatch(/receipt missing/);
      expect(r.evidence.join(" ")).toMatch(/byte-match/); // bytes agree — the receipt is the staleness
    }
    cleanup();
  });

  test("agent-cards stale: receipt source digests ≠ current sources", async () => {
    const w = buildDoctorWorld();
    const receiptPath = join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { sources: { card: string; sha256: string }[] };
    receipt.sources.find((s) => s.card === "autodev.md")!.sha256 = "sha256:" + "0".repeat(64); // lies about autodev.md, by name — order-independent (the fixture stages the full 7-card surface)
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    expect(g.evidence.join(" ")).toMatch(/receipt source digest for autodev\.md ≠ current source/);
    cleanup();
  });
});

describe("doctor v2 surface inventory — integrity-failure cell", () => {
  test("server-binary integrity-failure: tampered sidecar (frozen sha ≠ sidecar)", async () => {
    const w = buildDoctorWorld();
    const sidecar = `${w.frozenBin}.sha256`;
    writeFileSync(sidecar, `${"0".repeat(64)}  opencode\n`); // the sidecar lies
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("integrity-failure");
    expect(sb.evidence.join(" ")).toMatch(/frozen sha256 .* ≠ sidecar/);
    // one bad surface never fails the report: the other five still judged
    expect(bySurface(report, "extension").verdict).toBe("current");
    expect(bySurface(report, "agent-cards-global").verdict).toBe("current");
    cleanup();
  });
});

describe("doctor v2 surface inventory — unknown cells (every surface degrades individually)", () => {
  const DEAD_REMOTE = "/nonexistent/doctors-fixture-remote.git";

  test("server-binary unknown: unreachable fork remote", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("unknown");
    expect(sb.evidence.join(" ")).toMatch(/fork fetch failed/);
    // local facts still reported: integrity + running checks pass
    expect(sb.evidence.join(" ")).toMatch(/local checks pass/);
    cleanup();
  });

  test("extension unknown: unreachable amicode remote", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoAmicode, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxForWorld(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("unknown");
    expect(ext.evidence.join(" ")).toMatch(/amicode fetch failed/);
    // the agent-cards source is the LOCAL checkout — unaffected by the dead remote
    expect(bySurface(report, "agent-cards-global").verdict).toBe("current");
    cleanup();
  });

  test("vendored-binary unknown: unreachable fork remote (release tags not refreshable)", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    const report = await surfaceInventory(ctxForWorld(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("unknown");
    expect(vb.evidence.join(" ")).toMatch(/fork fetch failed/);
    cleanup();
  });

  test("staged-skills unknown: missing local source (no VSIX skills set)", async () => {
    const w = buildDoctorWorld();
    rmSync(w.vscext, { recursive: true, force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("unknown");
    expect(sk.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("agent-cards-global unknown: missing source dir", async () => {
    const w = buildDoctorWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("unknown");
    expect(g.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("agent-cards-staging unknown: missing source dir", async () => {
    const w = buildDoctorWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const st = bySurface(report, "agent-cards-staging");
    expect(st.verdict).toBe("unknown");
    expect(st.evidence.join(" ")).toMatch(/missing local source/);
    cleanup();
  });

  test("no report ever fails: all six records present even when every source is unreachable", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoFork, ["remote", "set-url", "origin", DEAD_REMOTE]);
    fixtureGit(w.repoAmicode, ["remote", "set-url", "origin", DEAD_REMOTE]);
    rmSync(w.vscext, { recursive: true, force: true });
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    expect(report.surfaces).toHaveLength(6);
    // every source of truth is dead → every surface degrades to unknown, and
    // the report still returns all six records — never a failed report
    expect(report.surfaces.every((r) => r.verdict === "unknown")).toBe(true);
    expect(report.surfaces.every((r) => r.evidence.length > 0)).toBe(true);
    cleanup();
  });
});

// ── reviewer adversarial variants (pass 2026-08-23) ──────────────────────────
// Born from the reviewer's scratch-probe pass against the real predicates
// (authorship gate, #525). Two probes found real gaps — the digest loops ran
// source→deployed only, so EXTRA staged/deployed content was judged current —
// fixed in src/surfaces.ts and pinned here (reverse-direction drift). The rest
// pin correct handling of adversarial inputs the implementer matrix never
// exercised. Full record: test/fixtures/surfaces/README.md.
describe("doctor v2 surface inventory — reviewer adversarial variants (2026-08-23)", () => {
  test("staged-skills stale: extra staged skill absent from the VSIX set (reverse-direction drift)", async () => {
    const w = buildDoctorWorld();
    mkdirSync(join(w.staging, "skills", "ghost"), { recursive: true });
    writeFileSync(join(w.staging, "skills", "ghost", "SKILL.md"), "# ghost\nleftover from an older deployment\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("stale");
    expect(sk.evidence.join(" ")).toMatch(/skill ghost extra in staged set/);
    expect(sk.evidence.join(" ")).not.toMatch(/skill (alpha|beta) /); // shared skills still byte-match
    expect(sk.version).not.toBe(sk.source_version); // deployed set identity includes the extra
    cleanup();
  });

  test("agent-cards-global stale: extra deployed card absent from sources (reverse-direction drift)", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.config, "agents", "ghost.md"), "---\nmode: ghost\n---\n# ghost\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    expect(g.evidence.join(" ")).toMatch(/card ghost\.md extra in deployed set/);
    expect(g.version).not.toBe(g.source_version);
    expect(bySurface(report, "agent-cards-staging").verdict).toBe("current"); // the other deployment is unaffected
    cleanup();
  });

  test("server-binary current: uppercase-hex sidecar digest is normalized", async () => {
    const w = buildDoctorWorld();
    writeFileSync(`${w.frozenBin}.sha256`, `${sha256File(w.frozenBin).toUpperCase()}  opencode\n`);
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("current");
    expect(sb.evidence.join(" ")).toMatch(/sha256 .* = sidecar/);
    cleanup();
  });

  test("server-binary current: build date exactly equal to HEAD commit date (boundary — equal is current)", async () => {
    // stamp derived from the pinned commit date, not duplicated: equal minutes
    const equalStamp = GIT_COMMIT_DATE.slice(0, 16).replace(/[-T:]/g, "");
    const w = buildDoctorWorld({ frozenVersion: `0.0.0-local/amicode-${equalStamp}` });
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("current"); // staleness is strict <, so equal passes
    expect(sb.evidence.join(" ")).toMatch(/build date .* ≥ HEAD commit date/);
    cleanup();
  });

  test("extension current: numeric version sort — 0.2.10 is newer than 0.2.9 (lexicographic would flip)", async () => {
    const w = buildDoctorWorld();
    const skillSrc = join(w.vscext, "harmoniqs.amicode-0.2.6", "skills");
    for (const v of ["0.2.9", "0.2.10"]) {
      cpSync(skillSrc, join(w.vscext, `harmoniqs.amicode-${v}`, "skills"), { recursive: true });
    }
    rmSync(join(w.vscext, "harmoniqs.amicode-0.2.6"), { recursive: true, force: true });
    rmSync(join(w.vscext, "harmoniqs.amicode-0.2.4-darwin-arm64"), { recursive: true, force: true });
    bumpExtensionOnRemote(w.remoteAmicode, "0.2.10");
    const report = await surfaceInventory(ctxForWorld(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("current");
    expect(ext.version).toBe("0.2.10");
    expect(bySurface(report, "staged-skills").verdict).toBe("current"); // compared against the 0.2.10 set
    cleanup();
  });

  test("vendored-binary unknown: reachable fork remote with NO release tags", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoFork, ["tag", "-d", "v1.18.10-amicode.15"]);
    fixtureGit(w.repoFork, ["push", "origin", ":refs/tags/v1.18.10-amicode.15"]);
    const report = await surfaceInventory(ctxForWorld(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("unknown");
    expect(vb.evidence.join(" ")).toMatch(/no fork release tags/);
    // the remote is REACHABLE — only the tagless surface degrades
    expect(bySurface(report, "server-binary").verdict).toBe("current");
    cleanup();
  });

  test("vendored-binary current: release-tag sort is numeric (v1.18.10-amicode.2 > v1.18.9-amicode.15)", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoFork, ["tag", "-d", "v1.18.10-amicode.15"]);
    fixtureGit(w.repoFork, ["push", "origin", ":refs/tags/v1.18.10-amicode.15"]);
    addReleaseTagOnRemote(w.remoteFork, "v1.18.9-amicode.15");
    addReleaseTagOnRemote(w.remoteFork, "v1.18.10-amicode.2");
    const report = await surfaceInventory(ctxForWorld(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("current");
    expect(vb.source_version).toBe("1.18.10"); // string sort would crown v1.18.9-amicode.15 → stale "ahead"
    expect(vb.evidence.join(" ")).toMatch(/latest fork release tag v1\.18\.10-amicode\.2/);
    cleanup();
  });

  test("server-binary integrity-failure: unexecutable frozen binary (--version fails)", async () => {
    const w = buildDoctorWorld();
    chmodSync(w.frozenBin, 0o644); // bytes unchanged: sidecar still matches — the exec is what breaks
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("integrity-failure");
    expect(sb.evidence.join(" ")).toMatch(/--version failed/);
    cleanup();
  });

  test("extension stale: installed AHEAD of origin/main (source repo behind)", async () => {
    const w = buildDoctorWorld();
    cpSync(join(w.vscext, "harmoniqs.amicode-0.2.6", "skills"), join(w.vscext, "harmoniqs.amicode-0.2.8", "skills"), { recursive: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const ext = bySurface(report, "extension");
    expect(ext.verdict).toBe("stale");
    expect(ext.version).toBe("0.2.8");
    expect(ext.source_version).toBe("0.2.6");
    expect(ext.evidence.join(" ")).toMatch(/ahead of origin\/main/);
    cleanup();
  });

  test("vendored-binary current: --version output with trailing whitespace is trimmed", async () => {
    const w = buildDoctorWorld();
    fakeBin(join(w.repoAmicode, "packages", "extension", "vendor", "opencode", LIVE_PLATFORM), "opencode", "1.18.10   ");
    const report = await surfaceInventory(ctxForWorld(w));
    const vb = bySurface(report, "vendored-binary");
    expect(vb.verdict).toBe("current");
    expect(vb.version).toBe("1.18.10"); // untrimmed it would compare unequal to the tag base
    cleanup();
  });

  test("server-binary stale: frozen binary missing (absent surface is the repairable state)", async () => {
    const w = buildDoctorWorld();
    rmSync(w.frozenBin, { force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("stale");
    expect(sb.evidence.join(" ")).toMatch(/frozen binary missing/);
    cleanup();
  });

  test("server-binary integrity-failure: sidecar missing while binary present", async () => {
    const w = buildDoctorWorld();
    rmSync(`${w.frozenBin}.sha256`, { force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const sb = bySurface(report, "server-binary");
    expect(sb.verdict).toBe("integrity-failure");
    expect(sb.evidence.join(" ")).toMatch(/sidecar missing/);
    cleanup();
  });

  test("staged-skills stale: staged dir entirely missing", async () => {
    const w = buildDoctorWorld();
    rmSync(join(w.staging, "skills"), { recursive: true, force: true });
    const report = await surfaceInventory(ctxForWorld(w));
    const sk = bySurface(report, "staged-skills");
    expect(sk.verdict).toBe("stale");
    expect(sk.evidence.join(" ")).toMatch(/staged skills dir missing or empty/);
    cleanup();
  });

  test("agent-cards stale: unparseable deploy receipt (bytes match — the receipt is the staleness)", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json"), "{not json");
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict).toBe("stale");
      expect(r.evidence.join(" ")).toMatch(/receipt unparseable/);
      expect(r.evidence.join(" ")).toMatch(/byte-match/);
    }
    cleanup();
  });
});

// ── #804: the mode-registry component verdicts (H5) — extend, never mint ─────
// The byte authority is the machine's RELEASE TAG (never origin HEAD, never
// the checkout); the revision authority is the RELEASE INDEX fetched from the
// remote. Tampering any one component flips the record stale with the
// component NAMED; a half-staged bundle reads stale, not current; locks and
// version gaps read their named outcomes; unknowns are named, never verdicts.
describe("doctor mode-registry component verdicts (#804)", () => {
  const componentOf = (record: SurfaceRecord, match: (c: { mode: string; component: string }) => boolean) =>
    (record.components ?? []).find(match);

  test("current world: the agent-cards records carry component verdicts, all current", async () => {
    const w = buildDoctorWorld();
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict).toBe("current");
      expect(r.components, `${name} components`).toBeDefined();
      for (const c of r.components!) {
        expect(c.verdict, `${name}/${c.mode}/${c.component}: ${c.evidence.join("; ")}`).toBe("current");
      }
      // every bundle component of the fixture registry is walked
      const components = r.components!.map((c) => `${c.mode}/${c.component}`);
      expect(components).toContain("autodev/card.md");
      expect(components).toContain("autodev/pack.toml");
      expect(components).toContain("autodev/mode.toml");
      expect(components).toContain("autodev/roles/implementer.md");
      expect(components).toContain("autoresearch/roles/hypothesizer.md");
      expect(components).toContain("registry/release-compare");
      expect(components).toContain("registry/deploy-receipt");
    }
    cleanup();
  });

  test("tampering ONE bundle component flips the record stale with the component NAMED (AC4)", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.config, "modes", "autoresearch", "pack.toml"), "# TAMPERED PACK\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    const named = componentOf(g, (c) => c.mode === "autoresearch" && c.component === "pack.toml");
    expect(named).toBeDefined();
    expect(named!.verdict).toBe("stale");
    expect(named!.evidence.join(" ")).toMatch(/component autoresearch\/pack\.toml changed/);
    // the OTHER deployment is unaffected
    expect(bySurface(report, "agent-cards-staging").verdict).toBe("current");
    cleanup();
  });

  test("a half-staged bundle (card new, roles old) reads stale with roles named — never current (AC4)", async () => {
    const w = buildDoctorWorld();
    // the card keeps matching the release; the role copy is OLD (stale bytes)
    writeFileSync(join(w.config, "modes", "autodev", "roles", "implementer.md"), "---\nmode: implementer\n---\n# OLD ROLE BYTES\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    const card = componentOf(g, (c) => c.mode === "autodev" && c.component === "card.md");
    expect(card!.verdict).toBe("current"); // the card alone is fine —
    const role = componentOf(g, (c) => c.mode === "autodev" && c.component === "roles/implementer.md");
    expect(role!.verdict).toBe("stale"); // — but the bundle as a unit is stale
    expect(role!.evidence.join(" ")).toMatch(/roles\/implementer\.md changed/);
    cleanup();
  });

  test("a LIVE staging lock reads staging-in-progress → unknown (AC2)", async () => {
    const w = buildDoctorWorld();
    const modesDir = join(w.config, "modes");
    const lock = {
      lock_version: 1,
      staging_root: modesDir,
      owner_pid: process.pid,
      owner_started: processStartTimeToken(process.pid) ?? "",
      liveness_token: "probe-fixture",
      acquired_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      ttl_ms: 120_000,
    };
    writeFileSync(join(modesDir, ".staging-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("unknown");
    expect(g.evidence.join(" ")).toMatch(/staging-in-progress/);
    const lockRow = componentOf(g, (c) => c.component === "staging-lock");
    expect(lockRow!.verdict).toBe("unknown");
    // the OTHER deployment has no lock — unaffected
    expect(bySurface(report, "agent-cards-staging").verdict).toBe("current");
    cleanup();
  });

  test("a STALE lock (heartbeat past TTL) reads stale-lock → failed and the record stale (AC3)", async () => {
    const w = buildDoctorWorld();
    const modesDir = join(w.config, "modes");
    const lock = {
      lock_version: 1,
      staging_root: modesDir,
      owner_pid: 999_999, // dead
      owner_started: "",
      liveness_token: "probe-fixture",
      acquired_at: "2020-01-01T00:00:00.000Z",
      heartbeat_at: "2020-01-01T00:00:00.000Z",
      ttl_ms: 120_000,
    };
    writeFileSync(join(modesDir, ".staging-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    const lockRow = componentOf(g, (c) => c.component === "staging-lock");
    expect(lockRow!.verdict).toBe("failed");
    expect(lockRow!.evidence.join(" ")).toMatch(/stale-lock/);
    cleanup();
  });

  test("a version gap between the bundle's doctor floor and THIS doctor fails LOUDLY (AC5)", async () => {
    const w = buildDoctorWorld();
    const manifestPath = join(w.config, "modes", "autodev", "mode.toml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('doctor = "1"', 'doctor = "2"'));
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("stale");
    const floorRow = componentOf(g, (c) => c.mode === "autodev" && c.component === "version-floor");
    expect(floorRow!.verdict).toBe("failed");
    expect(floorRow!.evidence.join(" ")).toMatch(/version gap/);
    expect(floorRow!.evidence.join(" ")).toMatch(/never a silent degrade/);
    // the staging deployment (same bundle content? no — its manifest still
    // says floor 1) stays current: the gap is per-deployment
    expect(bySurface(report, "agent-cards-staging").verdict).toBe("current");
    cleanup();
  });

  test("a machine a release behind renders `current to vX, stale to release vY` (AC6)", async () => {
    const w = buildDoctorWorld();
    advanceRegistryOnRemote(w.remoteAmicode, "v0.2.7", 2);
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict, `${name} must not read current for a release-behind machine`).toBe("stale");
      expect(r.evidence.join(" ")).toContain("current to v0.2.6, stale to release v0.2.7");
      const rel = componentOf(r, (c) => c.component === "release-compare")!;
      expect(rel.verdict).toBe("stale");
    }
    // the deployed bytes still match the machine's OWN release — the bundle
    // components themselves are current; the release compare is the staleness
    const g = bySurface(report, "agent-cards-global");
    expect(componentOf(g, (c) => c.mode === "autodev" && c.component === "card.md")!.verdict).toBe("current");
    cleanup();
  });

  test("a PRE-REGISTRY machine reads stale-to-release, never current (AC6, degraded_staging_is_honest)", async () => {
    const w = buildDoctorWorld({ preRegistryMachine: true });
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict, `pre-registry machine must never read current (${name})`).toBe("stale");
      expect(r.evidence.join(" ")).toContain("current to v0.2.4, stale to release v0.2.6");
    }
    cleanup();
  });

  test("an untagged/dev build renders a NAMED unknown, never a verdict (AC6)", async () => {
    const w = buildDoctorWorld();
    cpSync(join(w.vscext, "harmoniqs.amicode-0.2.6"), join(w.vscext, "harmoniqs.amicode-0.2.7-dev.2099010100"), { recursive: true });
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      expect(r.verdict).toBe("unknown");
      expect(r.evidence.join(" ")).toMatch(/untagged\/dev build/);
      const machineRow = componentOf(r, (c) => c.component === "machine-release");
      expect(machineRow!.verdict).toBe("unknown");
    }
    cleanup();
  });

  test("remote unreachable: the release compare reads a NAMED unknown, never a verdict (AC6)", async () => {
    const w = buildDoctorWorld();
    fixtureGit(w.repoAmicode, ["remote", "set-url", "origin", "/nonexistent/doctors-fixture-remote.git"]);
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const r = bySurface(report, name);
      const rel = componentOf(r, (c) => c.component === "release-compare")!;
      expect(rel.verdict).toBe("unknown");
      expect(rel.evidence.join(" ")).toMatch(/amicode fetch failed/);
      // local facts still govern: the tag bytes match, so the record reads
      // current WITH the named unknown riding it — never a silent pass
      expect(r.verdict).toBe("current");
    }
    cleanup();
  });

  test("the byte authority is the RELEASE TAG, never origin HEAD: a checkout ahead of the release does not flip the verdict", async () => {
    const w = buildDoctorWorld();
    // drift the CHECKOUT's registry ahead (uncommitted) — deployed matches tag
    writeFileSync(
      join(w.repoAmicode, "packages", "extension", "modes", "autodev", "pack.toml"),
      "# CHECKOUT-ONLY DRIFT\n",
    );
    const report = await surfaceInventory(ctxForWorld(w));
    const g = bySurface(report, "agent-cards-global");
    expect(g.verdict).toBe("current");
    expect(componentOf(g, (c) => c.mode === "autodev" && c.component === "pack.toml")!.verdict).toBe("current");
    cleanup();
  });
});

// ── the JSON contract (AC: schema + canonical form) ─────────────────────────
describe("doctor v2 JSON contract", () => {
  const schemaPath = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "doctor-report.schema.json");

  const representativeWorlds: { name: string; build: () => Promise<{ report: unknown; world: DoctorWorld }> }[] = [
    {
      name: "current world",
      build: async () => {
        const w = buildDoctorWorld();
        return { report: await surfaceInventory(ctxForWorld(w)), world: w };
      },
    },
    {
      name: "stale world (version-stale server binary)",
      build: async () => {
        const w = buildDoctorWorld({ frozenVersion: PAST_BUILD });
        return { report: await surfaceInventory(ctxForWorld(w)), world: w };
      },
    },
    {
      name: "integrity-failure world (tampered sidecar)",
      build: async () => {
        const w = buildDoctorWorld();
        writeFileSync(`${w.frozenBin}.sha256`, `${"0".repeat(64)}  opencode\n`);
        return { report: await surfaceInventory(ctxForWorld(w)), world: w };
      },
    },
    {
      name: "unknown world (dead fork remote)",
      build: async () => {
        const w = buildDoctorWorld();
        fixtureGit(w.repoFork, ["remote", "set-url", "origin", "/nonexistent/x.git"]);
        return { report: await surfaceInventory(ctxForWorld(w)), world: w };
      },
    },
  ];

  for (const world of representativeWorlds) {
    test(`${world.name}: report validates against the committed schema and round-trips byte-equal under the canonical form`, async () => {
      const { report } = await world.build();
      const v = validateDoctorReport(report);
      expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
      expect(v.ok).toBe(true);
      const once = canonicalJson(report);
      expect(once.endsWith("\n")).toBe(true); // trailing newline
      expect(once).toBe(canonicalJson(JSON.parse(once))); // round-trip byte-equal
      // #804 schema v2: every report is schema-stamped (sorted keys put it
      // first), then the surfaces array — 2-space indent, deep-sorted keys
      expect(once.split("\n")[1]).toBe('  "schema_version": "2",');
      expect(once.split("\n")[2]).toBe('  "surfaces": [');
      cleanup();
    });
  }

  test("the committed schema file itself is canonical (deep-sorted keys, 2-space, trailing newline)", () => {
    const raw = readFileSync(schemaPath, "utf8");
    expect(raw).toBe(canonicalJson(JSON.parse(raw)));
  });

  test("the committed schema enforces minItems 6 and the required record fields", () => {
    const schema = loadDoctorSchema();
    const surfaces = (schema.properties as Record<string, { minItems?: number }>).surfaces;
    expect(surfaces.minItems).toBe(6);
    const record = (schema.properties as Record<string, { items: { required: string[] } }>).surfaces.items;
    expect([...record.required].sort()).toEqual(["evidence", "surface", "verdict", "version"]);
  });

  test("schema rejects: five surfaces, missing field, bad verdict, non-array evidence", () => {
    const good = {
      schema_version: "2",
      surfaces: [
        { surface: "server-binary", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "extension", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "vendored-binary", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "staged-skills", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "agent-cards-global", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "agent-cards-staging", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
      ],
    };
    expect(validateDoctorReport(good).ok).toBe(true);

    const five = { schema_version: "2", surfaces: good.surfaces.slice(0, 5) };
    expect(validateDoctorReport(five).errors.some((e) => /at least 6 items/.test(e.message))).toBe(true);

    const missingField = { schema_version: "2", surfaces: good.surfaces.map((s, i) => (i === 0 ? { surface: "server-binary", verdict: "current", evidence: ["x"] } : s)) };
    expect(validateDoctorReport(missingField).errors.some((e) => e.path === "$.surfaces[0]" && /version/.test(e.message))).toBe(true);

    const badVerdict = { schema_version: "2", surfaces: good.surfaces.map((s, i) => (i === 1 ? { ...s, verdict: "borked" } : s)) };
    expect(validateDoctorReport(badVerdict).errors.some((e) => e.path === "$.surfaces[1].verdict")).toBe(true);

    const badEvidence = { schema_version: "2", surfaces: good.surfaces.map((s, i) => (i === 2 ? { ...s, evidence: "ok" } : s)) };
    expect(validateDoctorReport(badEvidence).errors.some((e) => e.path === "$.surfaces[2].evidence")).toBe(true);

    const emptyEvidence = { schema_version: "2", surfaces: good.surfaces.map((s, i) => (i === 3 ? { ...s, evidence: [] } : s)) };
    expect(validateDoctorReport(emptyEvidence).errors.some((e) => e.path === "$.surfaces[3].evidence")).toBe(true);

    const unknownSurface = { schema_version: "2", surfaces: good.surfaces.map((s, i) => (i === 4 ? { ...s, surface: "sidecar-bin" } : s)) };
    expect(validateDoctorReport(unknownSurface).errors.some((e) => e.path === "$.surfaces[4].surface")).toBe(true);
  });

  // #804 — the v2 bump: component-level verdicts ride the agent-cards records
  test("schema accepts component records; the bump is real (an unstamped v1 report is rejected)", () => {
    const withComponents = {
      schema_version: "2",
      surfaces: [
        { surface: "server-binary", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "extension", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "vendored-binary", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        { surface: "staged-skills", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
        {
          surface: "agent-cards-global", version: "1", source_version: "1", verdict: "current", evidence: ["ok"],
          components: [
            { mode: "autodev", component: "card.md", verdict: "current", evidence: ["byte-matches release"] },
            { mode: "registry", component: "release-compare", verdict: "stale", evidence: ["current to v0.3.1, stale to release v0.3.2"] },
          ],
        },
        { surface: "agent-cards-staging", version: "1", source_version: "1", verdict: "current", evidence: ["ok"] },
      ],
    };
    expect(validateDoctorReport(withComponents).ok, JSON.stringify(validateDoctorReport(withComponents).errors)).toBe(true);

    // component verdicts are enum-checked
    const badComponent = JSON.parse(JSON.stringify(withComponents)) as typeof withComponents;
    (badComponent.surfaces[4] as { components: { verdict: string }[] }).components[0].verdict = "borked";
    expect(validateDoctorReport(badComponent).errors.some((e) => e.path === "$.surfaces[4].components[0].verdict")).toBe(true);

    // the bump is REAL: a v1 report (no top-level schema_version) fails v2
    const v1 = { surfaces: withComponents.surfaces } as unknown;
    expect(validateDoctorReport(v1).errors.some((e) => e.path === "$" && /schema_version/.test(e.message))).toBe(true);
  });
});
