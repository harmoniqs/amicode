import * as vscode from "vscode";

// ============================================================================
// Placeholder TreeViews for vault / catalog / armonia.
// v0 ships an empty-state message; real implementations connect to
// ArmoniaService when that lands. Registering them now reserves the
// activitybar real estate.
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
  refresh(): void { this._onDidChange.fire(); }
}

export function registerTrees(ctx: vscode.ExtensionContext): {
  vault: PlaceholderTree;
  catalog: PlaceholderTree;
  armonia: PlaceholderTree;
} {
  const vault   = new PlaceholderTree("(vault tree will appear when Armonia mounts are configured)");
  const catalog = new PlaceholderTree("(catalog tree will appear when a public vault is mounted)");
  const armonia = new PlaceholderTree("(no mounts yet — run Amicode: Open Chat to start)");

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("amicode.vault",   vault),
    vscode.window.registerTreeDataProvider("amicode.catalog", catalog),
    vscode.window.registerTreeDataProvider("amicode.armonia", armonia),
  );

  return { vault, catalog, armonia };
}
