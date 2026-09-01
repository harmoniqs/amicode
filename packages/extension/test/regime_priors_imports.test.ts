// SEAM 2 (amicode #699) — the A1 boundary's structural half, made mechanical
// (the calib_chain_imports.test.ts / mocksoc_imports.test.ts pattern):
//
//   `no_intonatissimo_import_possible == 1` — the priors table is committed
//   GENERATED content; the module that serves it can never reach the
//   internal tier (no import outside node: builtins + the opencode-plugin
//   sibling set — Intonatissimo, ../src/, and any npm package beyond the
//   siblings are all unreachable by construction, and this pins the
//   construction).
//
//   `regime_priors_read_only == 1` — the module never writes: the table is
//   served, never mutated; prior applications + outcomes ride the EXISTING
//   recommendation mechanics (amicode_recommend propose/outcome → the
//   provenance-spine helpers in problems.ts), and the audit only READS the
//   events back. A direct fs write here would bypass the diff/hash/event
//   spine — the same invariant calib_chain's core lives under.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname, "..", "opencode-plugin", "regime_priors.ts");
const SIBLINGS = new Set(["./ledger_client", "./entities", "./problems"]);

describe("regime priors module — the A1 import surface (structural scan)", () => {
  const src = readFileSync(CORE, "utf8");

  it("imports only node: builtins + the opencode-plugin siblings (the internal tier is unreachable by construction)", () => {
    const imports = [
      ...src.matchAll(/^import[^"']*["']([^"']+)["'];?$/gm),
      ...src.matchAll(/^export[^"']*from["']([^"']+)["'];?$/gm),
    ].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(
        spec.startsWith("node:") || (spec.startsWith("./") && SIBLINGS.has(spec)),
        `import "${spec}" is outside the allowed surface (node: builtins + ${[...SIBLINGS].join(", ")})`,
      ).toBe(true);
    }
    // the module CODE never references the internal tier outside the boundary-
    // describing header comments (the data file leak guard lives in
    // regime_priors.test.ts — this scan pins the CODE's import surface).
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/Intonatissimo|VENDOR_PROFILES/);
  });

  it("performs no direct filesystem WRITE — the table is served read-only; applications ride the existing mechanics", () => {
    const offenders = src
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /fs\.(write|append|mkdir|rename|copy|rm|unlink)Sync/.test(l));
    expect(offenders, `direct fs writes in the regime priors module: ${JSON.stringify(offenders)}`).toEqual([]);
    // the events feed is the EXISTING one: the audit reads events.jsonl back
    // (read-only), it never appends.
    expect(src).toMatch(/readFileSync/);
    expect(src).not.toMatch(/appendEvent/);
  });
});
