import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinnedJuliaMinor,
  shouldOfferJuliaSetup,
  hasJuliaup,
  hasChannel,
  resolveChannelJulia,
  projectInstantiated,
  buildSetupSteps,
  juliaupInstallCommand,
  type Runner,
} from "../../src/substrate/julia_setup";

const tmp = () => mkdtempSync(join(tmpdir(), "amicode-julia-"));

describe("pinnedJuliaMinor", () => {
  it("parses the minor from a Manifest julia_version", () => {
    const d = tmp();
    writeFileSync(join(d, "Manifest.toml"), 'julia_version = "1.12.3"\nmanifest_format = "2.0"\n');
    expect(pinnedJuliaMinor(join(d, "Manifest.toml"))).toBe("1.12");
    rmSync(d, { recursive: true, force: true });
  });
  it("returns null on missing file or absent key", () => {
    const d = tmp();
    expect(pinnedJuliaMinor(join(d, "nope.toml"))).toBeNull();
    writeFileSync(join(d, "Manifest.toml"), 'manifest_format = "2.0"\n');
    expect(pinnedJuliaMinor(join(d, "Manifest.toml"))).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("shouldOfferJuliaSetup", () => {
  const ok = { juliaupPresent: true, channelPresent: true, projectInstantiated: true, dismissed: false };
  it("does not offer when the whole chain is present", () => {
    expect(shouldOfferJuliaSetup(ok)).toBe(false);
  });
  it("offers when any link is missing", () => {
    expect(shouldOfferJuliaSetup({ ...ok, juliaupPresent: false })).toBe(true);
    expect(shouldOfferJuliaSetup({ ...ok, channelPresent: false })).toBe(true);
    expect(shouldOfferJuliaSetup({ ...ok, projectInstantiated: false })).toBe(true);
  });
  it("never offers once dismissed, even if incomplete", () => {
    expect(shouldOfferJuliaSetup({ juliaupPresent: false, channelPresent: false, projectInstantiated: false, dismissed: true })).toBe(false);
  });
});

describe("shell probes (injected runner)", () => {
  const okRun: Runner = () => "ok";
  const throwRun: Runner = () => {
    throw new Error("not found");
  };

  it("hasJuliaup reflects the runner", () => {
    expect(hasJuliaup(okRun)).toBe(true);
    expect(hasJuliaup(throwRun)).toBe(false);
  });

  it("hasChannel probes the channel shim with +minor", () => {
    const seen: string[][] = [];
    const run: Runner = (_c, a) => {
      seen.push(a);
      return "julia version 1.12.6";
    };
    expect(hasChannel("1.12", run)).toBe(true);
    expect(seen[0][0]).toBe("+1.12");
    expect(hasChannel("1.12", throwRun)).toBe(false);
  });

  it("resolveChannelJulia joins Sys.BINDIR + returns null when the file is absent", () => {
    // BINDIR that doesn't exist -> null (file check fails)
    expect(resolveChannelJulia("1.12", () => "/nonexistent/bin")).toBeNull();
    expect(resolveChannelJulia("1.12", throwRun)).toBeNull();
  });

  it("resolveChannelJulia returns the path when the binary exists", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === "win32" ? "julia.exe" : "julia"), "");
    expect(resolveChannelJulia("1.12", () => bin)).toBe(join(bin, process.platform === "win32" ? "julia.exe" : "julia"));
    rmSync(d, { recursive: true, force: true });
  });
});

describe("projectInstantiated", () => {
  it("is true iff the project's Manifest exists", () => {
    const d = tmp();
    expect(projectInstantiated(d)).toBe(false);
    writeFileSync(join(d, "Manifest.toml"), "");
    expect(projectInstantiated(d)).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("buildSetupSteps", () => {
  const base = {
    minor: "1.12",
    project: "/home/u/.amico/julia",
    projectSrc: "/ext/julia/Project.toml",
    manifestSrc: "/ext/julia/Manifest.toml",
  };

  it("emits install + add + instantiate on a bare machine", () => {
    const steps = buildSetupSteps({ ...base, juliaupPresent: false, channelPresent: false });
    expect(steps.map((s) => s.label)).toEqual(["Install juliaup", "Add Julia 1.12", "Instantiate Piccolo project"]);
    expect(steps[0].command).toBe(juliaupInstallCommand());
    expect(steps[1].command).toBe("juliaup add 1.12");
  });

  it("skips install when juliaup is present, skips add when the channel exists", () => {
    expect(buildSetupSteps({ ...base, juliaupPresent: true, channelPresent: false }).map((s) => s.label)).toEqual([
      "Add Julia 1.12",
      "Instantiate Piccolo project",
    ]);
    expect(buildSetupSteps({ ...base, juliaupPresent: true, channelPresent: true }).map((s) => s.label)).toEqual([
      "Instantiate Piccolo project",
    ]);
  });

  it("instantiate runs through the channel + quotes paths", () => {
    const steps = buildSetupSteps({ ...base, juliaupPresent: true, channelPresent: true });
    expect(steps[0].command).toContain('julia +1.12 --project="/home/u/.amico/julia"');
    expect(steps[0].command).toContain("Pkg.instantiate()");
    expect(steps[0].command).toContain('cp "/ext/julia/Manifest.toml" "/home/u/.amico/julia/Manifest.toml"');
  });
});
