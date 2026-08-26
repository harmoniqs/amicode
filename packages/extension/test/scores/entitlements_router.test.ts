import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalEntitlementProvider, filterRepertoire, packageAllowlist } from "../../src/scores/entitlements";
import { buildRouterSection } from "../../src/scores/router";
import { Score } from "../../src/scores/loader";

function score(id: string, ents: string[], extra: Partial<Score["manifest"]> = {}): Score {
  return {
    manifest: {
      type: "score",
      schema_version: 1,
      id,
      version: 1,
      derived_from: null,
      name: `Name of ${id}`,
      outcome: `Outcome of ${id}`,
      audience: ["t"],
      entitlements: ents,
      stages: [{ id: "one" }],
      ...extra,
    },
    body: "",
    dir: `/scores/${id}`,
  };
}

describe("filterRepertoire (spec §5 entitlement semantics)", () => {
  const pub = score("pulse-designer", []);
  const gated = score("pasqal-mis", ["pasqal-hackathon-2026"], {
    device: { backend: "pasqal", qpu_runnable: true },
  });

  it("no code → public scores only", () => {
    expect(filterRepertoire([pub, gated], []).map((s) => s.manifest.id)).toEqual(["pulse-designer"]);
  });
  it("valid entitlement → gated scores visible", () => {
    expect(filterRepertoire([pub, gated], ["pasqal-hackathon-2026"]).map((s) => s.manifest.id)).toEqual([
      "pulse-designer",
      "pasqal-mis",
    ]);
  });
  it("absent entitlements field = public", () => {
    const s = score("x", []);
    delete (s.manifest as any).entitlements;
    expect(filterRepertoire([s], [])).toHaveLength(1);
  });
});

describe("LocalEntitlementProvider", () => {
  it("missing file → no entitlements, no error", async () => {
    const p = new LocalEntitlementProvider(path.join(os.tmpdir(), "nope-" + Date.now()));
    expect(await p.resolve()).toEqual({ entitlements: [] });
  });
  it("valid file → entitlements", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ents-"));
    fs.writeFileSync(path.join(dir, "entitlements.toml"), `codes = ["pasqal-hackathon-2026"]\n`);
    const p = new LocalEntitlementProvider(dir);
    expect(await p.resolve()).toEqual({ entitlements: ["pasqal-hackathon-2026"] });
  });
  it("malformed file → named error + empty entitlements (public fallback, never a dead end)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ents-"));
    fs.writeFileSync(path.join(dir, "entitlements.toml"), "codes = not-toml[");
    const p = new LocalEntitlementProvider(dir);
    expect(await p.resolve()).toEqual({ entitlements: [], error: "invalid_code" });
  });
  it("expired entry → named error + surviving valid codes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ents-"));
    fs.writeFileSync(
      path.join(dir, "entitlements.toml"),
      `codes = ["pasqal-hackathon-2026"]\nexpired = ["old-code-2025"]\n`,
    );
    const p = new LocalEntitlementProvider(dir);
    expect(await p.resolve()).toEqual({ entitlements: ["pasqal-hackathon-2026"], error: "expired_code" });
  });
});

describe("buildRouterSection", () => {
  const pub = score("pulse-designer", []);
  const gated = score("pasqal-mis", ["pasqal-hackathon-2026"], {
    device: { backend: "pasqal", qpu_runnable: true },
    duration_estimate: "60–90 min",
  });

  it("renders the onset question with fixed options", () => {
    const md = buildRouterSection([pub]);
    expect(md).toContain("What do you want to do today?");
    expect(md).toContain("Bring your own problem");
    expect(md).toContain("Resume the active problem");
    expect(md).toContain("Resume your research campaign");
    expect(md).toContain("Just explore");
    // pulse-designer is invocable by skill name but NOT a default onset option
    expect(md).not.toContain("Design a new pulse");
  });
  it("pulse-designer score is NOT surfaced as an entry card or fixed option", () => {
    const md = buildRouterSection([pub, gated]);
    const cardBlock = md.slice(md.indexOf("application entry cards"));
    expect(cardBlock).toContain("pasqal-mis");
    // pulse-designer must not appear anywhere — neither as entry card nor fixed option
    expect(md.indexOf("Name of pulse-designer")).toBe(-1);
    expect(md).not.toContain("Design a new pulse");
  });
  it("entry cards carry outcome, duration, and device badge", () => {
    const md = buildRouterSection([gated]);
    expect(md).toContain("Outcome of pasqal-mis");
    expect(md).toContain("60–90 min");
    expect(md).toContain("QPU");
  });
  it("no application scores → no empty entry-card section", () => {
    const md = buildRouterSection([pub]);
    expect(md).not.toContain("application entry cards");
  });
  it("is deterministic", () => {
    expect(buildRouterSection([pub, gated])).toBe(buildRouterSection([pub, gated]));
  });
});

describe("packageAllowlist (spec C entitlement → package tiers)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-allow-"));
  const registry = path.join(dir, "registry.toml");
  fs.writeFileSync(
    registry,
    `[packages]\ndefault = ["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"]\nissimo = ["Piccolissimo", "Legatissimo", "Intonatissimo"]\n`,
  );

  it("no entitlements → the five public packages", () => {
    expect(packageAllowlist(registry, [])).toEqual([
      "Piccolo",
      "Legato",
      "Intonato",
      "NamedTrajectories",
      "DirectTrajOpt",
    ]);
  });
  it("issimo entitlement → adds the three gated packages", () => {
    const allow = packageAllowlist(registry, ["issimo"]);
    expect(allow).toEqual(expect.arrayContaining(["Piccolo", "Piccolissimo", "Legatissimo", "Intonatissimo"]));
    expect(allow).toHaveLength(8);
  });
  it("missing file / malformed [packages] → public defaults, never throws", () => {
    expect(packageAllowlist(path.join(dir, "nope.toml"), ["issimo"])).toEqual([
      "Piccolo",
      "Legato",
      "Intonato",
      "NamedTrajectories",
      "DirectTrajOpt",
    ]);
  });
});
