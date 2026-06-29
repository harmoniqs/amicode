import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const BUNDLE = join(pkg, "dist", "amico-validate.js");
const validDir = join(here, "fixtures", "valid");
const invalidDir = join(here, "fixtures", "invalid");
const KINDS = ["run", "result", "lab", "solvespec", "catalog-entry", "finished"];

beforeAll(() => { execFileSync("node", [join(pkg, "esbuild.config.mjs")], { cwd: pkg }); });

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("amico-validate CLI", () => {
  it("valid fixtures → exit 0 (every kind, via --schema)", () => {
    for (const k of KINDS) {
      const r = run([join(validDir, `${k}.toml`), "--schema", k]);
      expect(r.code, `${k}: ${r.stderr}`).toBe(0);
    }
  });
  it("invalid fixtures → exit 64 + field-precise stderr (every kind)", () => {
    for (const k of KINDS) {
      const r = run([join(invalidDir, `${k}.toml`), "--schema", k]);
      expect(r.code, k).toBe(64);
      expect(r.stderr).toContain("INVALID");
    }
  });
  it("a committed WRONG-TYPE fixture fails field-precise (AC7 class matrix is self-contained)", () => {
    const r = run([join(invalidDir, "result-wrongtype.toml"), "--schema", "result"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("/fidelity: must be number");
  });
  it("file-role resolution by basename for the fixed-filename schemas (no --schema)", () => {
    expect(run([join(validDir, "run.toml")]).code).toBe(0);
    expect(run([join(validDir, "result.toml")]).code).toBe(0);
    expect(run([join(invalidDir, "result.toml")]).code).toBe(64);   // missing schema_version
  });
  it("FINISHED resolves by exact basename (no extension)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fin-")), "FINISHED");
    copyFileSync(join(validDir, "finished.toml"), f);
    expect(run([f]).code).toBe(0);
  });
  it("a non-filename schema without --schema cannot infer → 64", () => {
    const r = run([join(validDir, "solvespec.toml")]);   // solvespec.toml is not a canonical name
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("cannot infer");
  });
  it("field-precise stderr names the offending key + path", () => {
    const r = run([join(invalidDir, "lab.toml"), "--schema", "lab"]);
    expect(r.stderr).toContain("/transmon/levels");
  });
  it("usage / bad-arg errors exit 64", () => {
    expect(run([]).code).toBe(64);                          // no file
    expect(run(["a.toml", "b.toml"]).code).toBe(64);        // multiple files
    expect(run(["f.toml", "--schema", "bogus"]).code).toBe(64); // unknown schema
    expect(run(["f.toml", "--nope"]).code).toBe(64);        // unknown flag
  });
  it("--help exits 0", () => expect(run(["--help"]).code).toBe(0));
});
