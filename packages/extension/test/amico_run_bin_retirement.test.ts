// #1667 — the amico-run bin is deleted; the extension's spawn surface must
// have no reference to it. `amico run` is the byte-for-byte equivalent the
// launch surfaces route through now.
//
// The rule this test enforces: every occurrence of `amico-run` in the
// extension's TypeScript source (src/ + the opencode-plugin/ engine-side
// twin) must name the PACKAGE, never the deleted BIN — i.e. it must be part
// of the package spec `@amicode/amico-run` or a folder path
// (`packages/amico-run/…`, `"amico-run/launcher"`). A bare `amico-run`
// (an invocation, a PATH probe, an availability warning, a taught bash
// command) is a violation: it either spawns a bin that no longer exists or
// teaches the agent to.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

/** Collect .ts files under a dir (shallow for the plugin, recursive for src). */
function tsFiles(dir: string, recursive: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (recursive ? e.isDirectory() || e.isFile() : e.isFile()))
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p, recursive);
      return e.name.endsWith(".ts") ? [p] : [];
    });
}

/** A violation: `amico-run` that is neither the @amicode/ package spec nor a
 *  folder path segment (followed by "/"), nor preceded by "packages/". */
const BARE_BIN = /(?<!@amicode\/)(?<!packages\/)amico-run(?!\/)/g;

describe("#1667 — the amico-run bin is retired from the extension source", () => {
  const files = [...tsFiles(join(ROOT, "src"), true), ...tsFiles(join(ROOT, "opencode-plugin"), true)];

  it("the scan actually covers files (a vacuous pass proves nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no src/ or opencode-plugin/ file references the deleted bin (package-spec + folder paths only)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(BARE_BIN)) {
        const line = text.slice(0, m.index ?? 0).split("\n").length;
        violations.push(`${join(ROOT, f)}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the solve instruction teaches the router verb (`amico run`), not the deleted bin", () => {
    const cfg = readFileSync(join(ROOT, "src", "opencode_config.ts"), "utf8");
    expect(cfg).toContain("run `amico run <script>`");
    expect(cfg).not.toContain("`amico-run <script>`");
  });
});
