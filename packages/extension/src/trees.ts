import * as vscode from "vscode";

// ============================================================================
// TreeViews for armonia / catalog.
// amicode#204: the old redundant "Vault" + "Armonia" placeholder trees are
// merged into ONE Armonia panel (mounted Vaults are its roots; real rendering
// connects to ArmoniaService when it lands). The catalog tree is the #47
// SESSION catalog: entries collected by the save-to-catalog flow, persisted in
// workspaceState — explicitly NOT the Phase-3 CatalogStore (vault-backed,
// git-lfs pulse artifacts); it seeds the UX3 browser.
// ============================================================================

class PlaceholderTree implements vscode.TreeDataProvider<string> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly hint: string) {}

  getTreeItem(element: string): vscode.TreeItem {
    return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
  }
  getChildren(): string[] {
    return [this.hint];
  }
  refresh(): void {
    this._onDidChange.fire();
  }
}

/** A saved session-catalog entry (#47). Promote-shaped, mirrors the card's
 *  hydration source: enough to label the row and reopen the card. */
export interface SessionCatalogEntry {
  run_id: string;
  runDir: string;
  lab_id: string;
  fidelity: number;
  gate?: string;
  /** User-named system (falls back to the derived family). */
  system?: string;
  /** User-added tags — quick-digest handles for hyperparameter sweeps. */
  tags?: string[];
  saved_at: string;
}

const CATALOG_KEY = "amicode.sessionCatalog";

export class SessionCatalogTree implements vscode.TreeDataProvider<SessionCatalogEntry | string> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private entries(): SessionCatalogEntry[] {
    return this.ctx.workspaceState.get<SessionCatalogEntry[]>(CATALOG_KEY, []);
  }

  /** Record a save (newest first, deduped by run_id) and refresh the view. */
  async save(entry: SessionCatalogEntry): Promise<void> {
    const rest = this.entries().filter((e) => e.run_id !== entry.run_id);
    await this.ctx.workspaceState.update(CATALOG_KEY, [entry, ...rest]);
    this._onDidChange.fire();
  }

  /** Remove the POINTER record (unsave). Non-destructive by design: the run
   *  dir and pulse.jld2 stay on disk — deleting artifacts (and archive/
   *  supersede semantics) belongs to the Phase-3 CatalogStore (Q94/Q95). */
  async remove(run_id: string): Promise<void> {
    await this.ctx.workspaceState.update(
      CATALOG_KEY,
      this.entries().filter((e) => e.run_id !== run_id),
    );
    this._onDidChange.fire();
  }

  getTreeItem(el: SessionCatalogEntry | string): vscode.TreeItem {
    if (typeof el === "string") return new vscode.TreeItem(el, vscode.TreeItemCollapsibleState.None);
    // Chip-shaped label: gate · system · fidelity (Hamiltonian-based identity;
    // the lab is provenance — it lives in the tooltip + the card's metadata).
    const item = new vscode.TreeItem(
      `${el.gate ?? "?"} · ${el.system ?? "?"} · F=${el.fidelity.toFixed(5)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = el.run_id;
    item.tooltip = `lab: ${el.lab_id}${el.tags?.length ? `\ntags: ${el.tags.join(", ")}` : ""}\nsaved ${el.saved_at}\n${el.runDir}`;
    if (el.tags?.length) item.description = `${el.run_id} · ${el.tags.join(" · ")}`;
    item.command = {
      command: "amicode.catalogCard.open",
      title: "Open catalog card",
      arguments: [el.runDir, el.system, el.tags],
    };
    item.contextValue = "amicodeCatalogEntry"; // enables the row's context menu (remove)
    return item;
  }

  getChildren(): (SessionCatalogEntry | string)[] {
    const e = this.entries();
    return e.length ? e : ["(empty — save a converged run to the catalog)"];
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

export function registerTrees(ctx: vscode.ExtensionContext): {
  catalog: SessionCatalogTree;
  armonia: PlaceholderTree;
} {
  const catalog = new SessionCatalogTree(ctx);
  // amicode#204: the single Armonia panel. Its roots are the mounted Vaults;
  // until ArmoniaService lands, a product empty state names what collects here.
  const armonia = new PlaceholderTree("Your vaults collect here — run Amicode: Set up a vault");

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("amicode.catalog", catalog),
    vscode.window.registerTreeDataProvider("amicode.armonia", armonia),
  );

  return { catalog, armonia };
}
