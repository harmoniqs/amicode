import * as vscode from "vscode";

// ============================================================================
// TreeViews for armonia.
// amicode#204: the old redundant "Vault" + "Armonia" placeholder trees are
// merged into ONE Armonia panel (mounted Vaults are its roots; real rendering
// connects to ArmoniaService when it lands).
// The session catalog (SessionCatalogTree, amicode.catalog) was removed in
// #457 — the vault-backed CatalogStore (packages/amico-run) is the source of
// truth; the activity bar now shows only Armonia + Run Inspector.
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

export function registerTrees(ctx: vscode.ExtensionContext): {
  armonia: PlaceholderTree;
} {
  // amicode#204: the single Armonia panel. Its roots are the mounted Vaults;
  // until ArmoniaService lands, a product empty state names what collects here.
  const armonia = new PlaceholderTree("Your vaults collect here — run Amicode: Set up a vault");

  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("amicode.armonia", armonia));

  return { armonia };
}
