import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// S31 / spec §4: no PHYSICS flag parsing, no MCP, no HTTP in the orchestrator.
// (The original /SolveSpec/ ban is lifted by spec C: amico-run is now the
// named SolveSpec launch gate — it validates + gates the spec before spawning
// Julia. The physics-flag bans below still hold: --spec is a spec-file path,
// NOT a physics knob; all physics stays in the script.)
const FORBIDDEN = [/--gate\b/, /--system\b/, /--pulse\b/, /modelcontextprotocol/i, /node:https?\b/, /\bfetch\s*\(/];

// Δ8 (amicode#32, spec-20260628 cloud-solve-service) → #460 (amico-run
// dissolution): the cloud wire lives ONCE in cloud_client.ts, the thin
// `amico cloud` client RemoteExecutor delegates to. That module is the ONE
// sanctioned network edge in amico-run — submit→poll→mirror over the Δ2/Δ4
// API is its entire job. The S31 ban (no ambient HTTP in the orchestrator)
// stays for everything else; remote_executor.ts lost this exemption WITH the
// fetches (it makes no network calls at all now).
//
// slack_verb.ts (#1156): the OAuth PKCE login flow — a temporary HTTP
// callback server (node:http) + fetch for Slack's oauth.v2.access token
// exchange and users.info name resolution. Same class of sanctioned edge as
// the cloud client.
//
// jev_client.ts (#1311, slice of #1301 session curation): the ONE thin Jev
// client (TypeSafe System One decision API) for the confidence-gated
// curation middle layer — the amico-run doctrine's named home for that wire
// ("one thin client per repo, amico-run package for amicode surfaces" —
// spec-20260920-jev-integration). Fail-open by construction; every call
// receipted; the transport is injectable so the suite stays hermetic.
const EXEMPT = new Set(["cloud_client.ts", "slack_verb.ts", "jev_client.ts"]);

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
