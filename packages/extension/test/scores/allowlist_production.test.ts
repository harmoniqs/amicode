import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { writeAuthoringConfig, DEFAULT_SCORES_ROOT } from "../../src/opencode_config";

// Spec §3 regression (spec-20260704-113005): the allowlist MUST resolve from the
// REAL bundled assets, not a fixture that happens to carry its own [packages]
// table. Before the fix, writeAuthoringConfig read templates/registry.toml (no
// [packages] table) so holding `issimo` never actually allowlisted Piccolissimo
// in production — masked by fixture tests that wrote their own table.
describe("production-path entitlement allowlist (bundled assets)", () => {
  const savedEnv = process.env.AMICO_AUTHORING_FILE;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AMICO_AUTHORING_FILE;
    else process.env.AMICO_AUTHORING_FILE = savedEnv;
  });

  it("bundled scores/entitlements.toml carries the [packages] table", () => {
    const parsed = parseToml(
      fs.readFileSync(path.join(DEFAULT_SCORES_ROOT, "entitlements.toml"), "utf8"),
    ) as { packages?: { default?: string[]; issimo?: string[] } };
    expect(parsed.packages?.default).toContain("Piccolo");
    expect(parsed.packages?.issimo).toContain("Piccolissimo");
  });

  it("holding issimo yields Piccolissimo in authoring.json via the bundled table", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-ents-"));
    fs.writeFileSync(path.join(tmp, "entitlements.toml"), 'codes = ["issimo"]\n');
    process.env.AMICO_AUTHORING_FILE = path.join(tmp, "authoring.json");
    writeAuthoringConfig(tmp); // defaults → the real bundled scoresRoot
    const written = JSON.parse(fs.readFileSync(path.join(tmp, "authoring.json"), "utf8"));
    expect(written.allowlist).toContain("Piccolissimo");
    expect(written.allowlist).toContain("Piccolo"); // public base intact
  });

  it("no entitlements → public-only allowlist (negative baseline)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-ents-"));
    process.env.AMICO_AUTHORING_FILE = path.join(tmp, "authoring.json");
    writeAuthoringConfig(tmp);
    const written = JSON.parse(fs.readFileSync(path.join(tmp, "authoring.json"), "utf8"));
    expect(written.allowlist).not.toContain("Piccolissimo");
  });
});
