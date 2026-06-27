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
  it("defaults to ~/.amico/lab.toml", () =>
    expect(resolveLabTomlPath("")).toBe(join(homedir(), ".amico", "lab.toml")));
  it("expands a leading ~", () => {
    expect(resolveLabTomlPath("~")).toBe(homedir());
    expect(resolveLabTomlPath("~/x/lab.toml")).toBe(join(homedir(), "x", "lab.toml"));
  });
  it("uses an explicit path, trimmed", () =>
    expect(resolveLabTomlPath("  /a/lab.toml ")).toBe("/a/lab.toml"));
});

describe("checkLabToml", () => {
  it("a missing file is `absent`, not an error (a lab may be provisioned later)", () =>
    expect(checkLabToml(join(tmpdir(), "definitely-absent-lab-dir", "lab.toml")).state).toBe("absent"));
  it("a conforming lab.toml is `valid`", () =>
    expect(checkLabToml(writeLab(VALID)).state).toBe("valid"));

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
    expect(has(errs(VALID.replace('schema_version = "1"', 'schema_version = "9"')), "/schema_version: unrecognized version")).toBe(true));

  it("parity: checkLabToml uses the SAME validator as @amicode/schema directly (no second path)", () => {
    const p = writeLab(VALID.replace("levels = 3", "levels = 99"));
    const c = checkLabToml(p);
    expect(c.state).toBe("invalid");
    expect((c as { errors: string[] }).errors).toEqual(validateFile(p, "lab").errors);
  });
});

describe("the shipped starter lab.toml.example conforms", () => {
  it("scripts/lab.toml.example validates clean", () =>
    expect(validateFile(join(__dirname, "..", "scripts", "lab.toml.example"), "lab").errors).toEqual([]));
});
