import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeStopFile, savePulseTo, catalogPulsesDir } from "../src/run_controls";

describe("run_controls", () => {
  it("writeStopFile drops a STOP file into the run dir", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeStopFile(d);
    expect(existsSync(join(d, "STOP"))).toBe(true);
  });

  it("savePulseTo copies pulse.jld2 to the destination", () => {
    const src = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(src, "pulse.jld2"), "PULSEBYTES");
    const dst = join(mkdtempSync(join(tmpdir(), "out-")), "my.jld2");
    savePulseTo(src, dst);
    expect(readFileSync(dst, "utf8")).toBe("PULSEBYTES");
  });

  it("savePulseTo throws a clear error when no pulse.jld2 exists", () => {
    const src = mkdtempSync(join(tmpdir(), "run-"));
    expect(() => savePulseTo(src, join(tmpdir(), "x.jld2"))).toThrow(/no pulse/i);
  });

  it("catalogPulsesDir returns the dir when the team-vault catalog is present, else undefined", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    expect(catalogPulsesDir(home)).toBeUndefined();
    const catalog = join(home, ".amico", "vaults", "armonissima", "catalog", "pulses");
    mkdirSync(catalog, { recursive: true });
    expect(catalogPulsesDir(home)).toBe(catalog);
  });
});
