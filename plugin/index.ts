// ============================================================================
// amicode-plugin — runs inside the opencode runtime (loaded from
// .opencode/plugin/amicode-plugin.mjs via opencode auto-discovery).
//
// Hooks:
//   - tool.execute.before : if the user is about to call amico.run_julia,
//     inspect the args for bandwidth / amplitude hazards and surface a
//     warning via the extension callback (Channel 2). Doesn't BLOCK — just
//     informs.
//   - tool.execute.after  : after a successful amico.run_julia, if the
//     summary contains F > 0.99, POST a quick-pick prompt to the extension
//     asking whether to promote the run to the catalog.
//
// All HTTP calls go to process.env.AMICODE_EXTENSION_URL — set by the
// extension when it spawned opencode (env passed through ServerManager).
// ============================================================================

const EXTENSION_URL = process.env.AMICODE_EXTENSION_URL ?? "";

async function callback(action: unknown): Promise<unknown> {
  if (!EXTENSION_URL) return null;
  try {
    const r = await fetch(EXTENSION_URL + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    if (r.headers.get("content-type")?.includes("application/json")) {
      return await r.json();
    }
    return null;
  } catch {
    return null;
  }
}

// ----- hazard checks --------------------------------------------------------

interface RunJuliaArgs {
  system?: string;
  gate?: string;
  pulse?: string;
  T_ns?: number;
  omega_cap?: number;
  max_iter?: number;
}

function bandwidthHazards(args: RunJuliaArgs): string[] {
  const out: string[] = [];
  if (args.system === "transmon") {
    const T = args.T_ns;
    const omega = args.omega_cap ?? 0.05;
    const delta = 0.3; // GHz; default transmon anharmonicity

    if (T !== undefined && T < 20 && (args.gate === "X" || args.gate === "Y" || args.gate === "H")) {
      out.push(
        `Tight bandwidth budget: T=${T} ns at |δ|=${delta * 1000} MHz is close to the time-bandwidth floor ` +
        `(1/|δ| ≈ ${(1 / delta).toFixed(1)} ns). Expect F ≲ 0.95 unless T is bumped to ~30-40 ns or Ω cap to 100 MHz.`,
      );
    }
    if (T !== undefined && T < 150 && (args.gate === "CNOT" || args.gate === "CZ" || args.gate === "SWAP")) {
      out.push(
        `Two-qubit gate at T=${T} ns may be tight — typical CR-based CNOT needs 150-300 ns. ` +
        `Consider bumping T or expect convergence struggles.`,
      );
    }
    if (omega > 0.15) {
      out.push(
        `Drive cap Ω=${omega * 1000} MHz is above the 100-150 MHz RWA / weak-anharmonic boundary. ` +
        `Leakage to |2⟩ likely; rollout fidelity may diverge from solver fidelity.`,
      );
    }
  }
  return out;
}

function parseFidelityFromSummary(summary: string): number | null {
  const m = summary.match(/F\s*=\s*([\d.eE+-]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ----- plugin entrypoint ----------------------------------------------------

export default async function amicodePlugin() {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      if (input.tool !== "amico_run_julia" && input.tool !== "amico.run_julia") return;
      const hazards = bandwidthHazards(output.args ?? {});
      if (hazards.length > 0) {
        const msg = "⚠️ " + hazards.join("\n⚠️ ");
        await callback({ kind: "show-notification", level: "warn", message: msg });
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any },
    ) => {
      if (input.tool !== "amico_run_julia" && input.tool !== "amico.run_julia") return;
      const summary = output.output ?? "";
      const fid = parseFidelityFromSummary(summary);
      if (fid !== null && fid >= 0.99) {
        const replyTo = `promote-${Date.now()}`;
        const reply = (await callback({
          kind: "show-quick-pick",
          question: `Solve converged (F=${fid.toFixed(4)}). Promote pulse to catalog?`,
          choices: ["Yes — promote", "No — keep local only", "Iterate further"],
          replyTo,
        })) as { choice?: string } | null;
        if (reply?.choice === "Yes — promote") {
          // Catalog write happens extension-side via a refresh-tree action.
          await callback({ kind: "refresh-tree", tree: "catalog" });
          await callback({
            kind: "show-notification",
            level: "info",
            message: `Promoted run to local catalog. (Catalog tree refresh requested.)`,
          });
        }
      }
    },
  };
}
