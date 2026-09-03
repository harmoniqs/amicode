// `amico premium` (#750) — the entitlement-gated premium surface.
//
// The three properties this suite exists to defend:
//   1. NOT-GRANTED IS AN HONEST STATE, NOT AN ERROR. The vault machinery works
//      fully without the premium bundle (the split's funnel invariant); a
//      not-granted report exits 0 and names the grant path (repo access + the
//      entitlement code). No capability is forked — surfaces are unlocked by
//      grant, never diverged by build.
//   2. GRANTED LIGHTS THE SURFACES — each premium surface is probed and
//      reported present-or-absent honestly; a granted report never crashes on
//      a missing checkout, it names the absence.
//   3. THE ROUTING SEAM IS UNTOUCHED — the report only READS (entitlements
//      file, checkout paths, config presence); it never writes anything and
//      never re-points inference. Hermetic by construction: every probe is
//      injectable; no test touches a real path.
//
// Run: pnpm --filter @amicode/amico-run test premium
import { describe, it, expect } from "vitest";
import { premiumReport } from "../src/premium.js";

const dirs = (present: string[] = []) => ({
  checkDir: (p: string) => present.includes(p),
  checkFile: (p: string) => present.includes(p),
  readFile: (p: string) => {
    if (present.includes(p)) {
      if (p.endsWith("entitlements.toml")) return 'codes = ["amicissimo"]';
      return "";
    }
    return null;
  },
});

describe("amico premium — not granted (the funnel invariant)", () => {
  it("no entitlements file / no codes → not granted, exit 0, the honest message, zero premium probes", () => {
    let probes = 0;
    const r = premiumReport([], {
      ...dirs([]),
      readFile: () => null,
      checkDir: () => {
        probes += 1;
        return false;
      },
    });
    expect(r.exit).toBe(0);
    expect(r.granted).toBe(false);
    expect(r.rendered).toContain("works fully without it");
    expect(r.rendered).toContain("entitlements.toml");
    expect(probes).toBe(0); // not granted → the surfaces are not probed at all
  });

  it("codes without amicissimo (e.g. issimo alone) → still not granted for the premium surfaces", () => {
    const r = premiumReport([], {
      ...dirs([]),
      readFile: (p) => (p.endsWith("entitlements.toml") ? 'codes = ["issimo"]' : null),
      checkDir: () => false,
    });
    expect(r.granted).toBe(false);
    expect(r.exit).toBe(0);
  });

  it("--json not-granted contract: {granted: false, surfaces: {}}", () => {
    const r = premiumReport(["--json"], {
      ...dirs([]),
      readFile: () => null,
      checkDir: () => false,
    });
    expect(r.json).not.toBeNull();
    const parsed = JSON.parse(r.json!);
    expect(parsed.granted).toBe(false);
    expect(parsed.surfaces).toEqual({});
  });
});

describe("amico premium — granted (the surfaces light up)", () => {
  const GRANTED = [
    "/root/entitlements.toml",
    "/checkout/amicissimo",
    "/checkout/amicissimo/automation",
    "/checkout/amicissimo/vault/agents/researcher.md",
    "/checkout/amicissimo/vault/agents/dreamer.md",
    "/root/.amico/amicode/distiller.config.json",
  ];
  const grantedDirs = {
    checkDir: (p: string) => GRANTED.includes(p) || p.startsWith("/checkout/amicissimo"),
    checkFile: (p: string) => GRANTED.includes(p),
    readFile: (p: string) => (p.endsWith("entitlements.toml") ? 'codes = ["amicissimo"]' : null),
    listDir: (p: string) =>
      p.endsWith("vault/agents") ? ["researcher.md", "dreamer.md", "notes.txt"] : [],
  };

  it("granted + surfaces present → every surface reported, exit 0", () => {
    const r = premiumReport(["--checkout", "/checkout/amicissimo", "--config", "/root/.amico/amicode/entitlements.toml"], grantedDirs);
    expect(r.exit).toBe(0);
    expect(r.granted).toBe(true);
    expect(r.rendered).toContain("notturno engine");
    expect(r.rendered).toContain("2 agent"); // the tuned brain, counted
    expect(r.rendered).toContain("routing seam"); // the inference seam, named
  });

  it("granted + checkout MISSING → the absence is named, never a crash", () => {
    const r = premiumReport(["--checkout", "/nowhere/amicissimo", "--config", "/root/.amico/amicode/entitlements.toml"], {
      checkDir: () => false,
      checkFile: (p: string) => p === "/root/.amico/amicode/entitlements.toml",
      readFile: (p: string) => (p === "/root/.amico/amicode/entitlements.toml" ? 'codes = ["amicissimo"]' : null),
    });
    expect(r.exit).toBe(0);
    expect(r.granted).toBe(true);
    expect(r.rendered).toContain("not found"); // honest absence
    expect(r.surfaces.checkout).toBe(false);
  });

  it("--json granted contract: surfaces keyed with presence + counts", () => {
    const r = premiumReport(
      ["--json", "--checkout", "/checkout/amicissimo", "--config", "/root/.amico/amicode/entitlements.toml"],
      grantedDirs,
    );
    const parsed = JSON.parse(r.json!);
    expect(parsed.granted).toBe(true);
    expect(parsed.surfaces.checkout).toBe(true);
    expect(parsed.surfaces.notturno_engine).toBe(true);
    expect(parsed.surfaces.tuned_agents).toBe(2);
    expect(parsed.surfaces.routing_seam).toBe(true);
  });
});

describe("amico premium — the invariants", () => {
  it("never writes and never re-points inference: read-only by construction (exit 0 under total absence)", () => {
    const r = premiumReport([], { checkDir: () => false, checkFile: () => false, readFile: () => null });
    expect(r.exit).toBe(0); // the vault-machinery-only install works — the report is informational, never blocking
  });
});
