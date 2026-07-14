import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S31 / spec §4: no PHYSICS flag parsing, no MCP, no HTTP in the orchestrator.
// (The original /SolveSpec/ ban is lifted by spec C: amico-run is now the
// named SolveSpec launch gate — it validates + gates the spec before spawning
// Julia. The physics-flag bans below still hold: --spec is a spec-file path,
// NOT a physics knob; all physics stays in the script.)
const FORBIDDEN = [/--gate\b/, /--system\b/, /--pulse\b/, /modelcontextprotocol/i, /node:https?\b/, /\bfetch\s*\(/];

/** Every .ts under src/, recursively — the guard must cover subdirs (e.g.
 *  src/harness/) too, so the tool layer stays CLI/spawn: no HTTP, no MCP. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("S31 grep rule", () => {
  it("src/ contains no forbidden tool-layer patterns", () => {
    for (const f of srcFiles(join(__dirname, "..", "src"))) {
      const text = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) {
        expect(text, `${f} matches forbidden ${re}`).not.toMatch(re);
      }
    }
  });
});
