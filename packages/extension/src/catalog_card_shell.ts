// Catalog-card shell (#47, v1) — hosts the catalogcard component in a webview.
//
// The card appears only through the save-to-catalog flow: a converged run's
// promote prompt (live solves via the watcher, demo replays via the replay
// command) → "Save to catalog" → `amicode.catalogCard.open` with the run dir.
// The entry is hydrated from the REAL run artifacts: run.toml (identity),
// result.toml (fidelity, params — params.gate/params.system lifted to the
// entry's top level; iterations/wall → the proposed block), and the run.log
// pulse lines (meta + newest record → the card's plot). Not palette-
// contributed — there is no card without a run to save.
//
// Persistence note: opening a card stores nothing durable; the session
// catalog (trees.ts) records POINTERS only. Where promoted artifacts persist
// is the open Phase-3 CatalogStore design (Q91/Q92).

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { PulseStream, readTomlSafe, type PulseEvent } from "./run_dir_reader";

export function registerCatalogCard(ctx: vscode.ExtensionContext): void {
  const open = new Map<string, vscode.WebviewPanel>();   // run_id → live panel
  ctx.subscriptions.push(vscode.commands.registerCommand("amicode.catalogCard.open", (runDir: string, systemName?: string, tags?: string[]) => {
    const data = hydrateFromRunDir(runDir, systemName, tags);
    if (!data) {
      void vscode.window.showErrorMessage("Amicode: cannot build a catalog entry — run dir is missing run.toml/result.toml.");
      return;
    }
    const key = String(data.entry.run_id);
    const existing = open.get(key);
    if (existing) { existing.reveal(vscode.ViewColumn.One); return; }   // re-focus, don't re-create
    const panel = vscode.window.createWebviewPanel(
      "amicode.catalogCard", `Catalog: ${data.entry.run_id}`, vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(ctx.extensionUri, "dist"),
          vscode.Uri.joinPath(ctx.extensionUri, "media"),
        ],
      },
    );
    open.set(key, panel);
    panel.onDidDispose(() => open.delete(key), null, ctx.subscriptions);
    panel.webview.onDidReceiveMessage((m) => {
      if (m?.type !== "whatnext") return;
      // Wire the save → tune → warm-start ladder to the CHAT (the agent owns the
      // solve workflow): stage a concrete prompt on the clipboard and open the
      // chat. Promote (team catalog) stays honestly unwired until Phase 3.
      const e = data.entry;
      const ident = `${e.gate ?? "gate"} on ${e.system ?? String(e.lab_id)} (run ${e.run_id}, F=${Number(e.fidelity).toFixed(5)})`;
      if (m.id === "warmstart" || m.id === "tune") {
        const prompt = m.id === "warmstart"
          ? `Warm-start a new solve from the banked pulse of ${ident}: load ${runDir}/pulse.jld2 as the initial trajectory (load_traj), keep the same formulation, and run it.`
          : `Tune the solve for ${ident}: start from ${runDir}/pulse.jld2, keep the formulation but ask me which weights/params (Q, R, T, N, max_iter) to adjust before launching.`;
        void vscode.env.clipboard.writeText(prompt).then(async () => {
          await vscode.commands.executeCommand("amicode.openChat");
          void vscode.window.showInformationMessage(`Amicode: ${m.id} prompt copied — paste into the chat to launch.`);
        });
      } else if (m.id === "promote") {
        void vscode.window.showInformationMessage("Amicode: team-catalog promotion isn't wired yet (Phase 3) — the pulse stays in your local bank.");
      }
    });
    const uri = (...p: string[]) => panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...p));
    const nonce = Math.random().toString(36).slice(2);
    panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource} 'unsafe-inline';">
<link rel="stylesheet" href="${uri("media", "brand.css")}" />
<link rel="stylesheet" href="${uri("media", "layout.css")}" />
</head><body>
<script nonce="${nonce}">window.__CARD_DATA__ = ${JSON.stringify(data)};</script>
<script nonce="${nonce}" src="${uri("dist", "catalog_card_webview.js")}"></script>
</body></html>`;
  }));
}

/** Build the card's data from real run artifacts. Returns undefined when the
 *  dir lacks the promote-shaped basics. Shape mirrors the webview's CARD_DATA.
 *  Exported for tests. */
export function hydrateFromRunDir(runDir: string, systemName?: string, tags?: string[]): { entry: Record<string, unknown>; pulse?: { meta: unknown; record: unknown } } | undefined {
  const manifest = readTomlSafe(path.join(runDir, "run.toml"));
  const result = readTomlSafe(path.join(runDir, "result.toml"));
  if (!manifest || !result) return undefined;

  const params = (result.params ?? {}) as Record<string, unknown>;
  const entry: Record<string, unknown> = {
    schema_version: "1",
    run_id: String(manifest.run_id ?? path.basename(runDir)),
    lab_id: String(manifest.lab_id ?? "default"),
    gate: typeof params.gate === "string" ? params.gate : undefined,
    fidelity: Number(result.fidelity ?? 0),
    pulse_path: path.join(runDir, "pulse.jld2"),
    created_at: manifest.created_at,
    params,
    // Not in catalog-entry.schema.json — rendered visibly marked. The
    // user-assigned system name is the sharpest schema question here: human
    // identity ("Emerald-Q3") vs machine params (family/levels/δ).
    proposed: {
      system_name: systemName,
      tags,
      iterations: result.iterations,
      wall_seconds: result.wall_seconds,
    },
  };

  // Pulse plot from the run's own AMICODE_PULSE lines: meta + newest record.
  let pulse: { meta: unknown; record: unknown } | undefined;
  try {
    const stream = new PulseStream();
    let meta: PulseEvent | undefined, newest: PulseEvent | undefined;
    for (const line of fs.readFileSync(path.join(runDir, "run.log"), "utf8").split("\n")) {
      const e = stream.onLine(line);
      if (e?.type === "meta") { meta = e; newest = undefined; }
      else if (e?.type === "record") newest = e;
    }
    if (meta?.type === "meta" && newest?.type === "record") pulse = { meta: meta.meta, record: newest.record };
  } catch { /* no run.log → card renders the not-hydrated state */ }

  return { entry, pulse };
}
