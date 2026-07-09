import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S31 / spec §4: no PHYSICS flag parsing, no MCP, no HTTP in the orchestrator.
// (The original /SolveSpec/ ban is lifted by spec C: amico-run is now the
// named SolveSpec launch gate — it validates + gates the spec before spawning
// Julia. The physics-flag bans below still hold: --spec is a spec-file path,
// NOT a physics knob; all physics stays in the script.)
//
// ─────────────────────────────────────────────────────────────────────────────
// S31 AMENDMENT — B5 / issue #112 (MCP facade). ⚠️ NEEDS JACK GOVERNANCE REVIEW.
// ─────────────────────────────────────────────────────────────────────────────
// B5 lands the real `amico mcp-serve` MCP stdio transport (the OPTIONAL facade that
// exposes the spine verbs as MCP tools — one impl, two transports). That requires the
// `@modelcontextprotocol/sdk` import, which the /modelcontextprotocol/ ban forbids.
// Rather than removing the ban, we carve out EXACTLY ONE file — src/mcp_serve.ts —
// mirroring spec C, which amended the SolveSpec ban with a single named carve-out
// (amico-run = the launch gate) instead of a blanket lift. The carve-out is minimal:
//   • it names ONE file (MCP_SDK_ALLOWED), never the whole src/ tree;
//   • it lifts ONLY the /modelcontextprotocol/ pattern — mcp_serve.ts is STILL banned
//     from HTTP and fetch (the transport is stdio, never network) and from physics flags;
//   • every OTHER src file — orchestrator, harness, launch path — stays under the FULL
//     ban, MCP included. No orchestrator/harness code may import the MCP SDK.
// The two extra `it(...)` blocks below pin the carve-out so it cannot silently widen.
const MCP_SDK_PATTERN = /modelcontextprotocol/i;
const FORBIDDEN = [/--gate\b/, /--system\b/, /--pulse\b/, MCP_SDK_PATTERN, /node:https?\b/, /\bfetch\s*\(/];

// The MCP-SDK ban (/modelcontextprotocol/i) — and ONLY that ban — is lifted for these
// file(s). Keep this set at exactly the facade module.
const MCP_SDK_ALLOWED = new Set(["mcp_serve.ts"]);

describe("S31 grep rule", () => {
  it("src/ contains no forbidden tool-layer patterns (MCP-SDK carve-out: mcp_serve.ts only)", () => {
    const srcDir = join(__dirname, "..", "src");
    for (const f of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const re of FORBIDDEN) {
        // Narrow carve-out: the MCP-facade module may reference the MCP SDK (and ONLY the
        // SDK — it stays subject to every other forbidden pattern); every other file stays
        // subject to this one too.
        if (re === MCP_SDK_PATTERN && MCP_SDK_ALLOWED.has(f)) continue;
        expect(text, `${f} matches forbidden ${re}`).not.toMatch(re);
      }
    }
  });

  it("the MCP-SDK carve-out is exactly one file (no scope creep)", () => {
    expect([...MCP_SDK_ALLOWED]).toEqual(["mcp_serve.ts"]);
  });

  it("every non-carved-out src file is still MCP-SDK-free", () => {
    const srcDir = join(__dirname, "..", "src");
    for (const f of readdirSync(srcDir)) {
      if (MCP_SDK_ALLOWED.has(f)) continue;
      const text = readFileSync(join(srcDir, f), "utf8");
      expect(text, `${f} must not import the MCP SDK`).not.toMatch(MCP_SDK_PATTERN);
    }
  });
});
