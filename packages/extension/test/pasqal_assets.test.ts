// #161 (scope note from #159/#169): the extension stages the Pasqal validator
// into the ops dir at activation, at the DEFAULT path the fork's Connections
// panel resolves when $AMICO_PASQAL_VALIDATOR is unset:
//   <opsDir>/scripts/pasqal-connector/pasqal_validate.py
//   (opsDir = $AMICODE_OPS_DIR, else ~/.amico/amicode)
// Semantics: ALWAYS-COPY on activation. The default staged path is
// extension-owned — user overrides live behind $AMICO_PASQAL_VALIDATOR
// (pointing anywhere else), so overwriting here can never clobber user work,
// and every extension update refreshes the script with no staleness window.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASQAL_CONNECTOR_FILES, pasqalConnectorDir, stagePasqalConnector } from "../src/pasqal_assets";

// The REAL extension root — packages/extension/scripts/pasqal-connector ships
// in the vsix (see .vscodeignore negations + packaging.test.ts).
const EXTENSION_PATH = join(__dirname, "..");

let savedOps: string | undefined;
beforeEach(() => {
  savedOps = process.env.AMICODE_OPS_DIR;
});
afterEach(() => {
  if (savedOps === undefined) delete process.env.AMICODE_OPS_DIR;
  else process.env.AMICODE_OPS_DIR = savedOps;
});

describe("pasqalConnectorDir", () => {
  it("is <opsDir>/scripts/pasqal-connector — the panel's default resolution", () => {
    expect(pasqalConnectorDir("/ops")).toBe(join("/ops", "scripts", "pasqal-connector"));
  });
  it("defaults opsDir to $AMICODE_OPS_DIR", () => {
    process.env.AMICODE_OPS_DIR = "/elsewhere/ops";
    expect(pasqalConnectorDir()).toBe(join("/elsewhere/ops", "scripts", "pasqal-connector"));
  });
});

describe("stagePasqalConnector", () => {
  it("stages the validator + requirements into a fresh opsDir, creating dirs", () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-ops-"));
    const r = stagePasqalConnector(EXTENSION_PATH, opsDir);
    expect(r.dir).toBe(join(opsDir, "scripts", "pasqal-connector"));
    expect(r.staged).toEqual([...PASQAL_CONNECTOR_FILES]);
    for (const f of PASQAL_CONNECTOR_FILES) expect(existsSync(join(r.dir, f)), `missing ${f}`).toBe(true);
    // the staged validator is the shipped one, byte for byte
    expect(readFileSync(join(r.dir, "pasqal_validate.py"), "utf8")).toBe(
      readFileSync(join(EXTENSION_PATH, "scripts", "pasqal-connector", "pasqal_validate.py"), "utf8"),
    );
  });

  it("overwrites a stale copy at the default path (extension-owned; overrides live behind $AMICO_PASQAL_VALIDATOR)", () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-ops-"));
    const dir = pasqalConnectorDir(opsDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pasqal_validate.py"), "# stale from a previous extension version\n");
    stagePasqalConnector(EXTENSION_PATH, opsDir);
    expect(readFileSync(join(dir, "pasqal_validate.py"), "utf8")).not.toContain("stale");
  });

  it("is idempotent — a second activation stages identical content without error", () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-ops-"));
    const first = stagePasqalConnector(EXTENSION_PATH, opsDir);
    const second = stagePasqalConnector(EXTENSION_PATH, opsDir);
    expect(second).toEqual(first);
  });

  it("honors $AMICODE_OPS_DIR when opsDir is not passed (the extension-test idiom)", () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-ops-env-"));
    process.env.AMICODE_OPS_DIR = opsDir;
    const r = stagePasqalConnector(EXTENSION_PATH);
    expect(r.dir).toBe(join(opsDir, "scripts", "pasqal-connector"));
    expect(existsSync(join(r.dir, "pasqal_validate.py"))).toBe(true);
  });

  it("throws (naming the file) when a shipped asset is absent — activation logs it, never half-stages silently", () => {
    const fakeExtension = mkdtempSync(join(tmpdir(), "pasqal-noext-"));
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-ops-"));
    expect(() => stagePasqalConnector(fakeExtension, opsDir)).toThrow(/pasqal_validate\.py/);
  });

  it("tripwire: the extension really ships both connector assets at the source path", () => {
    for (const f of PASQAL_CONNECTOR_FILES)
      expect(existsSync(join(EXTENSION_PATH, "scripts", "pasqal-connector", f)), `missing source ${f}`).toBe(true);
  });
});
