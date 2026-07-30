import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  pinnedJuliaMinor,
  shouldOfferJuliaSetup,
  hasJuliaup,
  hasChannel,
  resolveChannelJulia,
  resolveJuliaupCommands,
  juliaProjectFingerprint,
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
  const commands = { juliaup: "/opt/juliaup/bin/juliaup", julia: "/opt/juliaup/bin/julia" };
  const okRun: Runner = () => "ok";
  const throwRun: Runner = () => {
    throw new Error("not found");
  };

  it("hasJuliaup reflects the runner", () => {
    expect(hasJuliaup(okRun, commands)).toBe(true);
    expect(hasJuliaup(throwRun, commands)).toBe(false);
  });

  it("hasChannel probes juliaup's launcher with +minor", () => {
    const seen: Array<[string, string[]]> = [];
    const run: Runner = (c, a) => {
      seen.push([c, a]);
      return "julia version 1.12.6";
    };
    expect(hasChannel("1.12", run, commands)).toBe(true);
    expect(seen[0]).toEqual([commands.julia, ["+1.12", "--startup-file=no", "--version"]]);
    expect(hasChannel("1.12", throwRun, commands)).toBe(false);
  });

  it("resolveChannelJulia joins Sys.BINDIR + returns null when the file is absent", () => {
    // BINDIR that doesn't exist -> null (file check fails)
    expect(resolveChannelJulia("1.12", () => "/nonexistent/bin", commands)).toBeNull();
    expect(resolveChannelJulia("1.12", throwRun, commands)).toBeNull();
  });

  it("resolveChannelJulia returns the path when the binary exists", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === "win32" ? "julia.exe" : "julia"), "");
    expect(resolveChannelJulia("1.12", () => bin, commands)).toBe(
      join(bin, process.platform === "win32" ? "julia.exe" : "julia"),
    );
    rmSync(d, { recursive: true, force: true });
  });
});

describe("resolveJuliaupCommands", () => {
  it("uses juliaup's sibling launcher when another julia appears earlier on PATH", () => {
    const d = tmp();
    const shadow = join(d, "shadow");
    const managed = join(d, "managed");
    mkdirSync(shadow, { recursive: true });
    mkdirSync(managed, { recursive: true });
    const suffix = process.platform === "win32" ? ".exe" : "";
    writeFileSync(join(shadow, `julia${suffix}`), "");
    writeFileSync(join(managed, `juliaup${suffix}`), "");
    writeFileSync(join(managed, `julia${suffix}`), "");

    expect(resolveJuliaupCommands(`${shadow}${delimiter}${managed}`)).toEqual({
      juliaup: join(managed, `juliaup${suffix}`),
      julia: join(managed, `julia${suffix}`),
    });
    rmSync(d, { recursive: true, force: true });
  });
});

describe("projectInstantiated", () => {
  it("requires a matching success marker, not merely a copied Manifest", () => {
    const d = tmp();
    const fingerprint = "abc123";
    expect(projectInstantiated(d, fingerprint)).toBe(false);
    writeFileSync(join(d, "Manifest.toml"), "");
    expect(projectInstantiated(d, fingerprint)).toBe(false);
    writeFileSync(join(d, ".amicode-instantiated"), "different\n");
    expect(projectInstantiated(d, fingerprint)).toBe(false);
    writeFileSync(join(d, ".amicode-instantiated"), `${fingerprint}\n`);
    expect(projectInstantiated(d, fingerprint)).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("juliaProjectFingerprint", () => {
  it("changes when either bundled project file changes", () => {
    const d = tmp();
    const project = join(d, "Project.toml");
    const manifest = join(d, "Manifest.toml");
    writeFileSync(project, "project-v1");
    writeFileSync(manifest, "manifest-v1");
    const initial = juliaProjectFingerprint(project, manifest);
    expect(initial).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(manifest, "manifest-v2");
    expect(juliaProjectFingerprint(project, manifest)).not.toBe(initial);
    expect(juliaProjectFingerprint(join(d, "missing"), manifest)).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("buildSetupSteps", () => {
  const base = {
    minor: "1.12",
    project: "/home/u/.amico/julia",
    projectSrc: "/ext/julia/Project.toml",
    manifestSrc: "/ext/julia/Manifest.toml",
    projectFingerprint: "abc123",
    juliaupCommands: { juliaup: "/managed/juliaup", julia: "/managed/julia" },
  };

  it("emits install + add + instantiate on a bare machine", () => {
    const steps = buildSetupSteps({ ...base, juliaupPresent: false, channelPresent: false });
    expect(steps.map((s) => s.label)).toEqual(["Install juliaup", "Add Julia 1.12", "Instantiate Piccolo project"]);
    expect(steps[0].command).toBe(juliaupInstallCommand());
    expect(steps[1].command).toBe('"/managed/juliaup" add 1.12');
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
    expect(steps[0].command).toContain('"/managed/julia" +1.12 --project="/home/u/.amico/julia"');
    expect(steps[0].command).toContain("Pkg.instantiate()");
    expect(steps[0].command).toContain('cp "/ext/julia/Manifest.toml" "/home/u/.amico/julia/Manifest.toml"');
    expect(steps[0].command).toContain(
      `printf '%s\\n' 'abc123' > "/home/u/.amico/julia/.amicode-instantiated.tmp"`,
    );
    expect(steps[0].command).toContain(
      'mv "/home/u/.amico/julia/.amicode-instantiated.tmp" "/home/u/.amico/julia/.amicode-instantiated"',
    );
  });
});
