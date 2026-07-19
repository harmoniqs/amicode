import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S31 / spec §4: no PHYSICS flag parsing, no MCP, no HTTP in the orchestrator.
// (The original /SolveSpec/ ban is lifted by spec C: amico-run is now the
// named SolveSpec launch gate — it validates + gates the spec before spawning
// Julia. The physics-flag bans below still hold: --spec is a spec-file path,
// NOT a physics knob; all physics stays in the script.)
const FORBIDDEN = [/--gate\b/, /--system\b/, /--pulse\b/, /modelcontextprotocol/i, /node:https?\b/, /\bfetch\s*\(/];

// Δ8 (amicode#32, spec-20260628 cloud-solve-service): RemoteExecutor is the
// ONE sanctioned network edge in amico-run — submit→poll over the Δ2/Δ4 API
// is its entire job. The S31 ban (no ambient HTTP in the orchestrator) stays
// for everything else; this exemption is scoped to the single module whose
// ratified contract IS HTTP. Same lift mechanism as the spec-C SolveSpec ban.
const EXEMPT = new Set(["remote_executor.ts"]);

describe("S31 grep rule", () => {
  it("src/ contains no forbidden tool-layer patterns", () => {
    const srcDir = join(__dirname, "..", "src");
    for (const f of readdirSync(srcDir)) {
      if (EXEMPT.has(f)) continue;
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const re of FORBIDDEN) {
        expect(text, `${f} matches forbidden ${re}`).not.toMatch(re);
      }
    }
  });
});
