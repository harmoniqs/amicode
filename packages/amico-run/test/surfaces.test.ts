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
import { writeFileSync, rmSync, readFileSync } from "node:fs";
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
  FUTURE_BUILD,
  PAST_BUILD,
  type DoctorWorld,
} from "./helpers.js";

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
    receipt.sources[0].sha256 = "sha256:" + "0".repeat(64); // lies about autodev.md
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
      expect(once.split("\n")[1]).toBe('  "surfaces": ['); // 2-space indent, sorted keys
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

    const five = { surfaces: good.surfaces.slice(0, 5) };
    expect(validateDoctorReport(five).errors.some((e) => /at least 6 items/.test(e.message))).toBe(true);

    const missingField = { surfaces: good.surfaces.map((s, i) => (i === 0 ? { surface: "server-binary", verdict: "current", evidence: ["x"] } : s)) };
    expect(validateDoctorReport(missingField).errors.some((e) => e.path === "$.surfaces[0]" && /version/.test(e.message))).toBe(true);

    const badVerdict = { surfaces: good.surfaces.map((s, i) => (i === 1 ? { ...s, verdict: "borked" } : s)) };
    expect(validateDoctorReport(badVerdict).errors.some((e) => e.path === "$.surfaces[1].verdict")).toBe(true);

    const badEvidence = { surfaces: good.surfaces.map((s, i) => (i === 2 ? { ...s, evidence: "ok" } : s)) };
    expect(validateDoctorReport(badEvidence).errors.some((e) => e.path === "$.surfaces[2].evidence")).toBe(true);

    const emptyEvidence = { surfaces: good.surfaces.map((s, i) => (i === 3 ? { ...s, evidence: [] } : s)) };
    expect(validateDoctorReport(emptyEvidence).errors.some((e) => e.path === "$.surfaces[3].evidence")).toBe(true);

    const unknownSurface = { surfaces: good.surfaces.map((s, i) => (i === 4 ? { ...s, surface: "sidecar-bin" } : s)) };
    expect(validateDoctorReport(unknownSurface).errors.some((e) => e.path === "$.surfaces[4].surface")).toBe(true);
  });
});
