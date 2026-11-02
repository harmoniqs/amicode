// #2095 — the VSIX leak gate: the would-be package file list (`vsce ls`, the
// same file-selection the release workflow's `vsce package` uses) must carry
// no source maps, no machine-provenance JSON, and no shipped text file may
// contain a developer-machine path or hostname outside the explicit,
// TODO-tagged allowlist (scripts/vsix_leak_allowlist.txt).
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listShippedFiles, scanShipped, scanContent, parseAllowlist } from "../scripts/vsix_leak_scan.mjs";

const EXT = join(__dirname, "..");

describe("vsix leak gate (#2095)", () => {
  it("the clean tree's package list has no maps, no provenance JSON, no machine strings", () => {
    const result = scanShipped(EXT);
    expect(result.files.length, "vsce ls listed nothing — the gate proves nothing").toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  }, 60_000);

  it("never lists the agents/ provenance records", () => {
    const files = listShippedFiles(EXT);
    expect(files).toContain("agents/develop.md");
    expect(files).not.toContain("agents/.seed-provenance.json");
    expect(files).not.toContain("agents/.deploy-receipt.json");
  }, 60_000);

  it("a planted map under bin/: the real .vscodeignore keeps it out; the pre-#2095 `!bin/**` rule ships it and the gate fails", () => {
    const binDist = join(EXT, "bin", "dist");
    const createdBin = !existsSync(join(EXT, "bin"));
    const map = join(binDist, "__leak_probe.js.map");
    const tmp = mkdtempSync(join(tmpdir(), "vsix-leak-"));
    // replay the regression: vsce honors ANY `!` match regardless of order, so
    // a bare `!bin/**` re-admits bin/**/*.map past `**/*.map`
    const legacyIgnore = join(tmp, ".vscodeignore");
    writeFileSync(legacyIgnore, readFileSync(join(EXT, ".vscodeignore"), "utf8").replace("!bin/**/!(*.map)", "!bin/**"));
    mkdirSync(binDist, { recursive: true });
    writeFileSync(map, "{}");
    try {
      expect(scanShipped(EXT).violations.filter((v) => v.kind === "source-map")).toEqual([]);
      expect(scanShipped(EXT, { ignoreFile: legacyIgnore }).violations).toContainEqual({ file: "bin/dist/__leak_probe.js.map", kind: "source-map" });
    } finally {
      rmSync(map, { force: true });
      rmSync(tmp, { recursive: true, force: true });
      if (createdBin) rmSync(join(EXT, "bin"), { recursive: true, force: true });
    }
  }, 60_000);

  it("fails on the personal vault name that used to be the strategy-brief default", () => {
    expect(scanContent("bin/dist/amico.js", 'join(HOME, "vaults", "vault-aaron", "sessions")', [])).toHaveLength(1);
  });

  it("fails on a planted machine path in a shipped text file", () => {
    const text = join(EXT, "templates", "__leak_probe.txt");
    writeFileSync(text, "seed_root = /home/aaron/.amico\n");
    try {
      expect(scanShipped(EXT).violations).toContainEqual(
        expect.objectContaining({ file: "templates/__leak_probe.txt", kind: "machine-string", match: "/home/aaron", line: 1 }),
      );
    } finally {
      rmSync(text, { force: true });
    }
  }, 60_000);

  it("allowlist entries permit exactly the named occurrence; anything else in the same file still fails", () => {
    const allow = parseAllowlist("# comment\n\nbin/dist/amico.js | [\"github-hosted\", \"erlich\", \"mini\"]  # TODO(#2095)\n");
    expect(allow).toEqual([{ file: "bin/dist/amico.js", needle: '["github-hosted", "erlich", "mini"]' }]);
    const content = 'var SURFACES2 = ["github-hosted", "erlich", "mini"];\nconst root = "/Users/aaron/x";\n';
    expect(scanContent("bin/dist/amico.js", content, allow)).toEqual([
      { file: "bin/dist/amico.js", kind: "machine-string", match: "/Users/aaron", line: 2, text: 'const root = "/Users/aaron/x";' },
    ]);
    expect(scanContent("bin/dist/other.js", 'x = "erlich"', allow)).toHaveLength(1);
  });
});
