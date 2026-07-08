import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S31 / spec §4: no PHYSICS flag parsing, no MCP, no HTTP in the orchestrator.
// (The original /SolveSpec/ ban is lifted by spec C: amico-run is now the
// named SolveSpec launch gate — it validates + gates the spec before spawning
// Julia. The physics-flag bans below still hold: --spec is a spec-file path,
// NOT a physics knob; all physics stays in the script.)
const FORBIDDEN = [/--gate\b/, /--system\b/, /--pulse\b/, /modelcontextprotocol/i, /node:https?\b/, /\bfetch\s*\(/];

describe("S31 grep rule", () => {
  it("src/ contains no forbidden tool-layer patterns", () => {
    const srcDir = join(__dirname, "..", "src");
    for (const f of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const re of FORBIDDEN) {
        expect(text, `${f} matches forbidden ${re}`).not.toMatch(re);
      }
    }
  });
});
