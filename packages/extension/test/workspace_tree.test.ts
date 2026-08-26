import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { registerWorkspaceTree, WorkspaceTreeProvider } from "../src/workspace_tree";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx() {
  return { subscriptions: [], extensionUri: vscode.Uri.file("/ext") } as any;
}

function fileItem(fsPath: string) {
  return { uri: vscode.Uri.file(fsPath), type: (vscode as any).FileType.File };
}

function dirItem(fsPath: string) {
  return { uri: vscode.Uri.file(fsPath), type: (vscode as any).FileType.Directory };
}

// ── Tree data ────────────────────────────────────────────────────────────────

describe("WorkspaceTreeProvider", () => {
  let provider: WorkspaceTreeProvider;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.file("/project"), name: "project", index: 0 },
    ];
    provider = new WorkspaceTreeProvider();
  });

  it("lists Chat with Amico action as the first root item", async () => {
    const roots = await provider.getChildren(undefined);
    expect(roots[0].action).toBe("openChat");
  });

  it("lists workspace folders as roots after the chat item", async () => {
    const roots = await provider.getChildren(undefined);
    expect(roots).toHaveLength(2);
    expect(roots[1].uri.fsPath).toBe("/project");
    expect(roots[1].type).toBe((vscode as any).FileType.Directory);
  });

  it("chat action item opens chat and uses yellow icon", () => {
    provider.setExtensionUri(vscode.Uri.file("/ext"));
    const chatItem = { uri: vscode.Uri.file("__chat__"), type: (vscode as any).FileType.File, action: "openChat" };
    const item = provider.getTreeItem(chatItem as any);
    expect(item.command).toMatchObject({ command: "amicode.openChat" });
    expect((item as any).iconPath.fsPath).toContain("chat-yellow.svg");
    expect((item as any).contextValue).toBe("chatAction");
  });

  it("chat action item is muted when chat is active", () => {
    provider.setExtensionUri(vscode.Uri.file("/ext"));
    provider.setChatActive(true);
    const chatItem = { uri: vscode.Uri.file("__chat__"), type: (vscode as any).FileType.File, action: "openChat" };
    const item = provider.getTreeItem(chatItem as any);
    expect((item as any).iconPath.fsPath).toContain("chat-muted.svg");
    expect(item.description).toBe("(open)");
  });

  it("expands directory children sorted dirs-first then alphabetically", async () => {
    vi.spyOn(vscode.workspace.fs, "readDirectory").mockResolvedValueOnce([
      ["beta.ts", (vscode as any).FileType.File],
      ["src", (vscode as any).FileType.Directory],
      ["alpha.ts", (vscode as any).FileType.File],
      [".git", (vscode as any).FileType.Directory],
      ["lib", (vscode as any).FileType.Directory],
    ] as any);

    const children = await provider.getChildren(dirItem("/project"));
    const names = children.map((c: any) => c.uri.fsPath.split("/").pop());

    // .git is excluded, dirs come first sorted, then files sorted
    expect(names).toEqual(["lib", "src", "alpha.ts", "beta.ts"]);
  });

  it("returns collapsible tree items for directories with resourceUri", () => {
    const item = provider.getTreeItem(dirItem("/project/src"));
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.label).toBe("src");
    expect((item as any).resourceUri.fsPath).toBe("/project/src");
    expect((item as any).contextValue).toBe("workspaceFolder");
  });

  it("returns workspaceRoot contextValue for root workspace folders", () => {
    const rootItem = {
      uri: vscode.Uri.file("/project"),
      type: (vscode as any).FileType.Directory,
      workspaceFolder: { uri: vscode.Uri.file("/project"), name: "project", index: 0 },
    };
    const item = provider.getTreeItem(rootItem as any);
    expect((item as any).contextValue).toBe("workspaceRoot");
  });

  it("returns non-collapsible tree items for files with open command", () => {
    const item = provider.getTreeItem(fileItem("/project/main.jl"));
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(item.label).toBe("main.jl");
    expect((item as any).contextValue).toBe("workspaceFile");
    expect(item.command).toMatchObject({
      command: "vscode.open",
      arguments: [{ fsPath: "/project/main.jl" }],
    });
  });
});

// ── Context menu commands ────────────────────────────────────────────────────

describe("Workspace context-menu commands", () => {
  let ctx: any;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: vscode.Uri.file("/project"), name: "project", index: 0 },
    ];
    (vscode.commands as any).executed = [];
    (vscode.env as any).clipboard.text = "";
    ctx = makeCtx();
    registerWorkspaceTree(ctx);
  });

  it("newFile creates an empty file and opens it", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("hello.jl" as any);
    const writeSpy = vi.spyOn(vscode.workspace.fs, "writeFile").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.newFile", dirItem("/project/src"));

    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/src/hello.jl" }),
      expect.any(Uint8Array),
    );
    expect((vscode.commands as any).executed).toContain("vscode.open");
  });

  it("newFile on a file item creates in the parent directory", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("sibling.ts" as any);
    const writeSpy = vi.spyOn(vscode.workspace.fs, "writeFile").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.newFile", fileItem("/project/src/main.jl"));

    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/src/sibling.ts" }),
      expect.any(Uint8Array),
    );
  });

  it("newFile does nothing when input is cancelled", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce(undefined as any);
    const writeSpy = vi.spyOn(vscode.workspace.fs, "writeFile");

    await vscode.commands.executeCommand("amicode.workspace.newFile", dirItem("/project"));

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("newFolder creates a directory", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("utils" as any);
    const mkdirSpy = vi.spyOn(vscode.workspace.fs, "createDirectory").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.newFolder", dirItem("/project"));

    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/utils" }),
    );
  });

  it("rename renames via workspace.fs", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("renamed.jl" as any);
    const renameSpy = vi.spyOn(vscode.workspace.fs, "rename").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.rename", fileItem("/project/old.jl"));

    expect(renameSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/old.jl" }),
      expect.objectContaining({ fsPath: "/project/renamed.jl" }),
    );
  });

  it("rename does nothing when user cancels or enters same name", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("old.jl" as any);
    const renameSpy = vi.spyOn(vscode.workspace.fs, "rename");

    await vscode.commands.executeCommand("amicode.workspace.rename", fileItem("/project/old.jl"));

    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("delete moves to trash when confirmed", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Move to Trash" as any);
    const deleteSpy = vi.spyOn(vscode.workspace.fs, "delete").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.delete", fileItem("/project/dead.ts"));

    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/dead.ts" }),
      { useTrash: true, recursive: true },
    );
  });

  it("delete permanently when confirmed", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce("Delete Permanently" as any);
    const deleteSpy = vi.spyOn(vscode.workspace.fs, "delete").mockResolvedValueOnce(undefined);

    await vscode.commands.executeCommand("amicode.workspace.delete", fileItem("/project/dead.ts"));

    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "/project/dead.ts" }),
      { recursive: true },
    );
  });

  it("delete does nothing when dismissed", async () => {
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce(undefined as any);
    const deleteSpy = vi.spyOn(vscode.workspace.fs, "delete");

    await vscode.commands.executeCommand("amicode.workspace.delete", fileItem("/project/keep.ts"));

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("copyPath writes absolute path to clipboard", async () => {
    await vscode.commands.executeCommand("amicode.workspace.copyPath", fileItem("/project/src/main.jl"));

    expect(vscode.env.clipboard.text).toBe("/project/src/main.jl");
  });

  it("copyRelativePath writes workspace-relative path to clipboard", async () => {
    await vscode.commands.executeCommand("amicode.workspace.copyRelativePath", fileItem("/project/src/main.jl"));

    expect(vscode.env.clipboard.text).toBe("src/main.jl");
  });

  it("revealInOS delegates to the built-in command", async () => {
    await vscode.commands.executeCommand("amicode.workspace.revealInOS", fileItem("/project/file.jl"));

    expect((vscode.commands as any).executed).toContain("revealFileInOS");
  });

  it("openInTerminal creates a terminal at the directory", async () => {
    const termSpy = vi.spyOn(vscode.window, "createTerminal");

    await vscode.commands.executeCommand("amicode.workspace.openInTerminal", dirItem("/project/src"));

    expect(termSpy).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project/src" }));
  });

  it("openToSide opens file in beside column", async () => {
    await vscode.commands.executeCommand("amicode.workspace.openToSide", fileItem("/project/file.jl"));

    expect((vscode.commands as any).executed).toContain("vscode.open");
  });

  it("removeFromWorkspace removes the folder at the correct index", async () => {
    const updateSpy = vi.spyOn(vscode.workspace as any, "updateWorkspaceFolders");
    const folder = (vscode.workspace as any).workspaceFolders[0];
    const rootItem = { uri: folder.uri, type: (vscode as any).FileType.Directory, workspaceFolder: folder };

    await vscode.commands.executeCommand("amicode.workspace.removeFromWorkspace", rootItem);

    expect(updateSpy).toHaveBeenCalledWith(0, 1);
  });

  it("removeFromWorkspace does nothing for non-root items", async () => {
    const updateSpy = vi.spyOn(vscode.workspace as any, "updateWorkspaceFolders");

    await vscode.commands.executeCommand("amicode.workspace.removeFromWorkspace", dirItem("/project/src"));

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
