import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { validateFile } from "@amicode/schema";
import { resolveLabTomlPath, checkLabToml } from "../src/lab_config";

const VALID =
  'schema_version = "1"\n[lab]\nname = "demo-lab"\n' +
  "[transmon]\nomega_GHz = 5.0\ndelta_GHz = 0.2\nlevels = 3\ndrive_max_GHz = 0.2\n";

function writeLab(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "lab-")), "lab.toml");
  writeFileSync(p, content);
  return p;
}
function errs(content: string): string[] {
  const c = checkLabToml(writeLab(content));
  return c.state === "invalid" ? c.errors : [];
}
const has = (es: string[], needle: string) => es.some((e) => e.includes(needle));

describe("resolveLabTomlPath", () => {
  it("defaults to ~/.amico/lab.toml", () => expect(resolveLabTomlPath("")).toBe(join(homedir(), ".amico", "lab.toml")));
  it("expands a leading ~", () => {
    expect(resolveLabTomlPath("~")).toBe(homedir());
    expect(resolveLabTomlPath("~/x/lab.toml")).toBe(join(homedir(), "x", "lab.toml"));
  });
  it("uses an explicit path, trimmed", () => expect(resolveLabTomlPath("  /a/lab.toml ")).toBe("/a/lab.toml"));
});

describe("checkLabToml", () => {
  it("a missing file is `absent`, not an error (a lab may be provisioned later)", () =>
    expect(checkLabToml(join(tmpdir(), "definitely-absent-lab-dir", "lab.toml")).state).toBe("absent"));
  it("a conforming lab.toml is `valid`", () => expect(checkLabToml(writeLab(VALID)).state).toBe("valid"));

  // field-precise negative matrix (#16 ACs / S17)
  it("missing required key → names the absent key + path", () =>
    expect(has(errs(VALID.replace("drive_max_GHz = 0.2\n", "")), 'missing required key "drive_max_GHz"')).toBe(true));
  it("wrong type → names the offending key", () =>
    expect(has(errs(VALID.replace("levels = 3", 'levels = "three"')), "/transmon/levels: must be integer")).toBe(true));
  it("out-of-range → names the offending key (distinct from wrong-type)", () =>
    expect(has(errs(VALID.replace("levels = 3", "levels = 99")), "/transmon/levels: must be <= 10")).toBe(true));
  it("unknown / misspelled key → names that key", () =>
    expect(has(errs(VALID + "rogue = 1\n"), 'unknown key "rogue"')).toBe(true));
  it("absent schema_version → field-precise required error", () =>
    expect(has(errs(VALID.replace('schema_version = "1"\n', "")), 'missing required key "schema_version"')).toBe(true));
  it("unrecognized schema_version → version-specific error", () =>
    expect(
      has(errs(VALID.replace('schema_version = "1"', 'schema_version = "9"')), "/schema_version: unrecognized version"),
    ).toBe(true));

  it("hardware range bounds are field-precise (#29: omega/drive_max/delta) + name minLength", () => {
    expect(has(errs(VALID.replace("omega_GHz = 5.0", "omega_GHz = 999")), "/transmon/omega_GHz: must be <= 100")).toBe(
      true,
    );
    expect(
      has(errs(VALID.replace("drive_max_GHz = 0.2", "drive_max_GHz = 50")), "/transmon/drive_max_GHz: must be <= 10"),
    ).toBe(true);
    expect(has(errs(VALID.replace("delta_GHz = 0.2", "delta_GHz = 25")), "/transmon/delta_GHz: must be <= 2")).toBe(
      true,
    ); // garbage anharmonicity
    expect(has(errs(VALID.replace('name = "demo-lab"', 'name = ""')), "/lab/name")).toBe(true); // minLength
  });

  it("parity over a corpus: checkLabToml === @amicode/schema.validateFile on every input (no second path) [#16]", () => {
    const corpus = [
      VALID, // valid
      VALID.replace("drive_max_GHz = 0.2\n", ""), // missing required
      VALID.replace("levels = 3", 'levels = "three"'), // wrong type
      VALID.replace("levels = 3", "levels = 99"), // out of range
      VALID.replace("delta_GHz = 0.2", "delta_GHz = 25"), // out of range (delta)
      VALID + "rogue = 1\n", // unknown key
      VALID.replace('schema_version = "1"\n', ""), // absent version
      VALID.replace('schema_version = "1"', 'schema_version = "9"'), // unrecognized version
    ];
    for (const content of corpus) {
      const p = writeLab(content);
      const c = checkLabToml(p);
      const direct = validateFile(p, "lab");
      expect(c.state === "valid" ? [] : (c as { errors: string[] }).errors).toEqual(direct.errors);
    }
  });
});

describe("valid lab profiles conform (demo + Schuster)", () => {
  it("scripts/lab.toml.example (the shipped starter) validates clean", () =>
    expect(validateFile(join(__dirname, "..", "scripts", "lab.toml.example"), "lab").errors).toEqual([]));
  it("a Schuster-profile lab (negative-convention δ, 4 levels) validates clean", () => {
    // Distinct from demo-lab: negative anharmonicity convention + a 4-level model,
    // exercising the schema's range tolerance on a second real-shaped profile.
    const schuster =
      'schema_version = "1"\n[lab]\nname = "schuster-transmon"\n' +
      "[transmon]\nomega_GHz = 4.8\ndelta_GHz = -0.33\nlevels = 4\ndrive_max_GHz = 0.1\n";
    expect(checkLabToml(writeLab(schuster)).state).toBe("valid");
  });
});
