// sidebar_view.ts — WebviewViewProvider for the Amicode sidebar (#673).
//
// Replaces the native TreeDataProvider (workspace_tree.ts) with a webview that
// can render custom UI: styled buttons, project metadata, lifecycle pills, and
// eventually a fleet section. The sidebar is navigation chrome — destinations
// open in the editor area; it never hosts chat or rich visualizations.
//
// Pattern: WebviewViewProvider (sidebar view), CSP nonce, typed bridge.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { handleSidebarMessage, type SidebarMessageHandlers, type SidebarDownMessage, type FileOpRequest, type FileOpResult, type TreeEntry } from "./sidebar_bridge";
import { SidebarTreeService, type RawDirEntry } from "./sidebar_tree_service";
import { detectProjectType } from "./project/detect";

// ── Icon theme resolution ────────────────────────────────────────────────────

/** Data structure passed to the webview for icon rendering. */
export interface IconThemeData {
  mode: "font" | "svg" | "none";
  /** CSS to inject (@font-face + icon classes for font themes, empty otherwise). */
  css: string;
  /** File extension → icon identifier (CSS class for font, webview URI for svg). */
  fileExtensions: Record<string, string>;
  /** Exact file name → icon identifier. */
  fileNames: Record<string, string>;
  /** Default folder icon identifier. */
  folder: string;
  /** Expanded folder icon identifier. */
  folderExpanded: string;
  /** Default file icon identifier. */
  defaultFile: string;
}

/**
 * Pure function: parse a VS Code icon theme JSON and produce an IconThemeData.
 *
 * @param themeJson   Parsed icon theme contribution JSON (or null).
 * @param basePath    Directory containing the theme JSON (for resolving relative paths).
 * @param resolveUri  Converts an absolute file path to a webview-loadable URI string.
 * @param langExtMap  Optional mapping from file extension (no dot) to VS Code language ID,
 *                    built from vscode.extensions.all[*].contributes.languages.
 *                    Enables the languageIds icon resolution path that Seti relies on.
 * @param colorThemeKind  "light" | "dark" (default "dark"). When "light", overlays the
 *                        theme's `light` section onto the base mappings.
 */
export function buildIconMap(
  themeJson: any,
  basePath: string,
  resolveUri: (absolutePath: string) => string,
  langExtMap?: Record<string, string>,
  colorThemeKind?: "light" | "dark",
): IconThemeData {
  const empty: IconThemeData = {
    mode: "none", css: "",
    fileExtensions: {}, fileNames: {},
    folder: "", folderExpanded: "", defaultFile: "",
  };
  if (!themeJson || typeof themeJson !== "object") return empty;

  // Merge the light variant overrides when on a light theme
  let effective = themeJson;
  if (colorThemeKind === "light" && themeJson.light) {
    const lt = themeJson.light;
    effective = {
      ...themeJson,
      file: lt.file ?? themeJson.file,
      folder: lt.folder ?? themeJson.folder,
      folderExpanded: lt.folderExpanded ?? themeJson.folderExpanded,
      fileExtensions: { ...themeJson.fileExtensions, ...lt.fileExtensions },
      fileNames: { ...themeJson.fileNames, ...lt.fileNames },
      languageIds: { ...themeJson.languageIds, ...lt.languageIds },
    };
  }

  const defs: Record<string, any> = themeJson.iconDefinitions ?? {};
  const isFontTheme = Array.isArray(themeJson.fonts) && themeJson.fonts.length > 0;

  if (isFontTheme) {
    return buildFontIconMap(effective, basePath, resolveUri, defs, langExtMap);
  }
  // SVG-based theme
  return buildSvgIconMap(effective, basePath, resolveUri, defs, langExtMap);
}

function buildFontIconMap(
  themeJson: any, basePath: string,
  resolveUri: (p: string) => string,
  defs: Record<string, any>,
  langExtMap?: Record<string, string>,
): IconThemeData {
  const font = themeJson.fonts[0];
  const fontSrc = font.src?.[0];
  if (!fontSrc) return { mode: "none", css: "", fileExtensions: {}, fileNames: {}, folder: "", folderExpanded: "", defaultFile: "" };

  const fontUri = resolveUri(path.resolve(basePath, fontSrc.path));
  const fontSize = font.size ?? "150%";
  const fontId = font.id ?? "icon-theme-font";

  // Build @font-face + base class
  let css = `@font-face { font-family: "${fontId}"; src: url("${fontUri}") format("${fontSrc.format ?? "woff"}"); font-weight: normal; font-style: normal; }\n`;
  css += `.theme-icon { font-family: "${fontId}"; font-size: ${fontSize}; -webkit-font-smoothing: antialiased; }\n`;

  // Build per-definition CSS classes
  const classMap: Record<string, string> = {}; // defName -> CSS class
  for (const [defName, def] of Object.entries(defs)) {
    if (!def?.fontCharacter) continue;
    const cls = `thi-${defName.replace(/^_/, "")}`;
    classMap[defName] = cls;
    css += `.${cls}::before { content: "${def.fontCharacter}"; color: ${def.fontColor ?? "inherit"}; }\n`;
  }

  // Map file extensions + names to CSS classes
  const fileExtensions: Record<string, string> = {};
  for (const [ext, defName] of Object.entries(themeJson.fileExtensions ?? {})) {
    if (classMap[defName as string]) fileExtensions[ext] = classMap[defName as string];
  }
  // languageIds resolution: ext → langId → defName → CSS class (lower priority)
  const langIcons: Record<string, string> = themeJson.languageIds ?? {};
  if (langExtMap) {
    for (const [ext, langId] of Object.entries(langExtMap)) {
      if (fileExtensions[ext]) continue; // direct mapping wins
      const defName = langIcons[langId];
      if (defName && classMap[defName]) fileExtensions[ext] = classMap[defName];
    }
  }
  const fileNames: Record<string, string> = {};
  for (const [name, defName] of Object.entries(themeJson.fileNames ?? {})) {
    if (classMap[defName as string]) {
      const cls = classMap[defName as string];
      fileNames[name] = cls;
      // Case-insensitive variants (Seti uses lowercase; real files vary)
      const lower = name.toLowerCase();
      const upper = name.toUpperCase();
      // "readme.md" → "README.MD" won't match, but common patterns:
      // "readme.md" → "README.md" (uppercase base, keep extension case)
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const upperBase = base.toUpperCase() + ext;
      if (!fileNames[lower]) fileNames[lower] = cls;
      if (!fileNames[upper]) fileNames[upper] = cls;
      if (!fileNames[upperBase]) fileNames[upperBase] = cls;
    }
  }

  return {
    mode: "font",
    css,
    fileExtensions,
    fileNames,
    folder: classMap[themeJson.folder] ?? "",
    folderExpanded: classMap[themeJson.folderExpanded] ?? "",
    defaultFile: classMap[themeJson.file] ?? "",
  };
}

function buildSvgIconMap(
  themeJson: any, basePath: string,
  resolveUri: (p: string) => string,
  defs: Record<string, any>,
  langExtMap?: Record<string, string>,
): IconThemeData {
  // Resolve definition name → webview URI
  const uriMap: Record<string, string> = {};
  for (const [defName, def] of Object.entries(defs)) {
    if (!(def as any)?.iconPath) continue;
    uriMap[defName] = resolveUri(path.resolve(basePath, (def as any).iconPath));
  }

  const fileExtensions: Record<string, string> = {};
  for (const [ext, defName] of Object.entries(themeJson.fileExtensions ?? {})) {
    if (uriMap[defName as string]) fileExtensions[ext] = uriMap[defName as string];
  }
  // languageIds resolution (lower priority)
  const langIcons: Record<string, string> = themeJson.languageIds ?? {};
  if (langExtMap) {
    for (const [ext, langId] of Object.entries(langExtMap)) {
      if (fileExtensions[ext]) continue;
      const defName = langIcons[langId];
      if (defName && uriMap[defName]) fileExtensions[ext] = uriMap[defName];
    }
  }
  const fileNames: Record<string, string> = {};
  for (const [name, defName] of Object.entries(themeJson.fileNames ?? {})) {
    if (uriMap[defName as string]) {
      const uri = uriMap[defName as string];
      fileNames[name] = uri;
      const lower = name.toLowerCase();
      const upper = name.toUpperCase();
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const upperBase = base.toUpperCase() + ext;
      if (!fileNames[lower]) fileNames[lower] = uri;
      if (!fileNames[upper]) fileNames[upper] = uri;
      if (!fileNames[upperBase]) fileNames[upperBase] = uri;
    }
  }

  return {
    mode: "svg",
    css: "",
    fileExtensions,
    fileNames,
    folder: uriMap[themeJson.folder] ?? "",
    folderExpanded: uriMap[themeJson.folderExpanded] ?? "",
    defaultFile: uriMap[themeJson.file] ?? "",
  };
}

/**
 * Build a file-extension → language-ID map from VS Code's installed extensions.
 * Used to resolve the icon theme's `languageIds` section (e.g. .jl → julia → _julia).
 */
export function buildLangExtMap(extensionList: any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const ext of extensionList ?? []) {
    const languages: any[] = ext.packageJSON?.contributes?.languages ?? [];
    for (const lang of languages) {
      const langId = lang.id;
      if (!langId) continue;
      for (const fileExt of lang.extensions ?? []) {
        const clean = fileExt.replace(/^\./, "");
        if (clean && !map[clean]) map[clean] = langId;
      }
    }
  }
  return map;
}

/**
 * Read the active VS Code file icon theme and produce an IconThemeData.
 * Returns mode "none" if the theme can't be read (graceful fallback).
 */
function resolveIconTheme(webview: vscode.Webview): { data: IconThemeData; rootUri?: vscode.Uri } {
  const none = { data: buildIconMap(null, "", (p) => p) };
  try {
    const themeId = vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
    if (!themeId) return none;

    // Build the language-extension map once for all icon resolution
    const langExtMap = buildLangExtMap(vscode.extensions.all as any[]);

    for (const ext of vscode.extensions.all ?? []) {
      const themes: any[] | undefined = ext.packageJSON?.contributes?.iconThemes;
      if (!themes) continue;
      const theme = themes.find((t: any) => t.id === themeId);
      if (!theme?.path) continue;

      const themeJsonPath = path.resolve(ext.extensionPath, theme.path);
      const themeJson = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
      const basePath = path.dirname(themeJsonPath);
      const rootUri = vscode.Uri.file(basePath);

      // Detect light vs dark color theme
      const themeKind = vscode.window.activeColorTheme?.kind;
      // ColorThemeKind: 1=Light, 2=Dark, 3=HighContrast, 4=HighContrastLight
      const colorThemeKind: "light" | "dark" = (themeKind === 1 || themeKind === 4) ? "light" : "dark";

      const data = buildIconMap(
        themeJson, basePath,
        (p) => webview.asWebviewUri(vscode.Uri.file(p)).toString(),
        langExtMap,
        colorThemeKind,
      );
      return { data, rootUri };
    }
  } catch {
    // Graceful fallback — sidebar works without icons
  }
  return none;
}

/**
 * Provides the sidebar webview for the Amicode workspace panel.
 * Registered as `amicode.workspace` (type: "webview" in package.json).
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private extensionUri: vscode.Uri;
  private view?: vscode.WebviewView;
  private chatActive = false;
  private activeProjectPath: string | null | undefined = undefined;
  private watcher?: vscode.FileSystemWatcher;
  private workspaceSub?: vscode.Disposable;
  private gitSubs: vscode.Disposable[] = [];
  private treeService: SidebarTreeService;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.treeService = new SidebarTreeService({
      detectProjectType,
      readToml: (dir) => readResearchToml(dir),
      readDirectory: (dir) => readDirectoryEntries(dir),
      getExcludePatterns: () => getExcludePatterns(),
      getWorkspaceFolders: () => (vscode.workspace.workspaceFolders ?? []) as Array<{ uri: { fsPath: string }; name: string }>,
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
   ): void {
    this.view = webviewView;

    // Clear the view-level title so VS Code shows only the container title ("AMICODE")
    // rather than "AMICODE: AMICODE".
    webviewView.title = "";

    // Resolve the active file icon theme for file/folder icons in the tree.
    const iconTheme = resolveIconTheme(webviewView.webview);
    const localRoots = [
      vscode.Uri.joinPath(this.extensionUri, "dist"),
      vscode.Uri.joinPath(this.extensionUri, "media"),
    ];
    if (iconTheme.rootUri) localRoots.push(iconTheme.rootUri);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    };

    // CSP nonce — regenerated per resolve (not cached).
    const nonce = getNonce();

    // Bundle URI for the browser entry point.
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar_webview.js"),
    );

    webviewView.webview.html = this.buildHtml(webviewView.webview, nonce, scriptUri, iconTheme.data);

    // Wire up the bridge: webview → host messages.
    webviewView.webview.onDidReceiveMessage((msg) => {
      const handlers: SidebarMessageHandlers = {
        openChat: () => vscode.commands.executeCommand("amicode.openChat"),
        newProject: () => vscode.commands.executeCommand("amicode.newProject"),
        addExisting: () => addExistingProject(),
        getRoots: () => {
          const roots = this.treeService.getRoots();
          // Schedule a git-status push so colors survive the DOM wipe
          // that renderRoots() causes in the webview.
          queueMicrotask(() => this.pushGitStatus());
          return roots;
        },
        getChildren: async (p) => {
          const entries = await this.treeService.getChildren(p);
          return annotateGitStatus(entries);
        },
        openFile: (p) => {
          const uri = vscode.Uri.file(p);
          void vscode.window.showTextDocument(uri);
        },
        fileOp: (req) => executeFileOp(req),
        postMessage: (m) => {
          void webviewView.webview.postMessage(m);
        },
      };
      void handleSidebarMessage(msg, handlers);
    });

    // FileSystemWatcher — refresh subtrees on changes.
    this.setupWatcher(webviewView);

    // Git extension — subscribe to repository state changes for reactive coloring.
    this.setupGitWatcher();

    // Refresh when workspace folders change.
    this.workspaceSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.postDown({ kind: "roots", roots: this.treeService.getRoots() });
      this.pushGitStatus();
    });

    webviewView.onDidDispose(() => {
      this.watcher?.dispose();
      this.workspaceSub?.dispose();
      for (const sub of this.gitSubs) sub.dispose();
      this.gitSubs = [];
      this.view = undefined;
    });
  }

  /** Push chat-active state to the webview so it can dim the button. */
  setChatActive(active: boolean): void {
    if (this.chatActive !== active) {
      this.chatActive = active;
      this.postDown({ kind: "chat-active", active });
    }
  }

  /**
   * Set the active project path (from the active session's binding).
   * Posts active-project to the webview for highlight + auto-expand.
   * Pass null to clear (no session or no project binding).
   */
  setActiveProject(projectPath: string | null): void {
    if (this.activeProjectPath === projectPath) return; // deduplicate
    this.activeProjectPath = projectPath;
    this.postDown({ kind: "active-project", path: projectPath });
  }

  private postDown(msg: SidebarDownMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Push current git status to the webview immediately (no debounce).
   * Called after every roots re-render so git colors survive the DOM wipe.
   */
  private pushGitStatus(): void {
    try {
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (!gitExt?.isActive) return;
      const api = gitExt.exports?.getAPI?.(1);
      if (!api) return;
      const statusMap = buildGitStatusMap(api);
      this.postDown({ kind: "git-status", statusMap });
    } catch {
      // Graceful — sidebar works without git colors
    }
  }

  private setupWatcher(webviewView: vscode.WebviewView): void {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const onFsEvent = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) {
        void webviewView.webview.postMessage({
          kind: "fs-changed",
          folder: folder.uri.fsPath,
        });
      }
    };
    this.watcher.onDidCreate(onFsEvent);
    this.watcher.onDidChange(onFsEvent);
    this.watcher.onDidDelete(onFsEvent);
  }

  /**
   * Subscribe to git extension repository state changes.
   * When any repo's state changes, push a git-status message to the webview
   * with the full status map so it can re-color all visible labels.
   * Debounced (300ms) to avoid flooding on rapid git operations.
   */
  private setupGitWatcher(): void {
    try {
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (!gitExt) return;

      const wireApi = (api: any) => {
        if (!api) return;

        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const pushStatus = () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const statusMap = buildGitStatusMap(api);
            this.postDown({ kind: "git-status", statusMap });
          }, 300);
        };

        // Subscribe to each existing repository's state changes
        for (const repo of api.repositories ?? []) {
          if (repo?.state?.onDidChange) {
            this.gitSubs.push(repo.state.onDidChange(pushStatus));
          }
        }

        // Subscribe to newly opened repositories
        if (api.onDidOpenRepository) {
          this.gitSubs.push(api.onDidOpenRepository((repo: any) => {
            if (repo?.state?.onDidChange) {
              this.gitSubs.push(repo.state.onDidChange(pushStatus));
            }
            // Push immediately for the new repo's current state
            pushStatus();
          }));
        }

        // Fire once immediately so the sidebar gets git colors on load
        pushStatus();
      };

      if (gitExt.isActive) {
        wireApi(gitExt.exports?.getAPI?.(1));
      } else {
        // Git extension not active yet — activate and wire when ready
        gitExt.activate().then(() => {
          wireApi(gitExt.exports?.getAPI?.(1));
        });
      }
    } catch {
      // Graceful fallback — sidebar works without git colors
    }
  }

  private buildHtml(
    webview: vscode.Webview,
    nonce: string,
    scriptUri: string | { toString(): string },
    iconTheme: IconThemeData,
  ): string {
    const cspSource = webview.cspSource;
    const iconThemeJson = JSON.stringify(iconTheme);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource}; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${iconTheme.css}
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBar-background);
    }
    .sidebar-header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px;
      flex-shrink: 0;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .sidebar-header button {
      width: 100%;
      padding: 5px 8px;
      border: none;
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-chat {
      background: #fff676;
      color: #666;
      border: none;
      font-weight: 400;
    }
    .btn-chat:hover {
      background: #ffe94a;
    }
    .btn-chat:focus {
      outline: none;
    }
    .btn-chat .btn-icon {
      width: 14px;
      height: 14px;
      vertical-align: -2px;
      margin-right: 4px;
    }
    .btn-chat .btn-icon rect,
    .btn-chat .btn-icon polygon {
      fill: #666;
    }
    .btn-chat .btn-icon path {
      stroke: #aaa;
    }
    .btn-chat.muted {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid #fff676;
      opacity: 0.7;
    }
    .btn-chat.muted .btn-icon rect,
    .btn-chat.muted .btn-icon polygon {
      fill: #fff676;
    }
    .btn-chat.muted .btn-icon path {
      stroke: #999;
    }
    .btn-new-project {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid #2B382B;
      font-weight: 400;
    }
    .btn-new-project:hover {
      background: rgba(43, 56, 43, 0.15);
    }
    .btn-new-project:focus {
      outline: none;
    }
    #tree-root {
      display: contents;
    }
    /* ── Accordion sections ────────────────────────────────────── */
    .section {
      position: absolute;
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }
    .section-body {
      overflow: hidden;
      min-height: 0;
      flex: 1;
    }
    .section-body.expanded {
      overflow-y: auto;
    }
    .sidebar-sections {
      flex: 1;
      position: relative;
      overflow: hidden;
      min-height: 0;
    }
    /* Animated expand/collapse — VS Code PaneView pattern.
       Added temporarily by JS during toggles; removed after 150ms. */
    .sidebar-sections.animated .section {
      transition: top 0.15s ease-out, height 0.15s ease-out;
    }
    .tree-node {
      display: flex;
      align-items: center;
      padding: 2px 8px 2px 0;
      cursor: pointer;
      user-select: none;
    }
    .tree-node:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-node .indent {
      flex-shrink: 0;
    }
    .tree-node .chevron {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      transition: transform 0.15s ease;
    }
    .tree-node .chevron.expanded {
      transform: rotate(90deg);
    }
    .tree-node .icon {
      width: 16px;
      height: 16px;
      margin-right: 4px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .tree-node img.icon {
      display: block;
    }
    .tree-node .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-node .pill {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      margin-left: 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      flex-shrink: 0;
    }
    /* ── Git status colors ─────────────────────────────────────── */
    .git-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .git-added { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .git-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); text-decoration: line-through; }
    .git-untracked { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
    .git-ignored { color: var(--vscode-gitDecoration-ignoredResourceForeground, #8c8c8c); opacity: 0.6; }
    .git-conflict { color: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b); }
    /* ── Drag and drop ─────────────────────────────────────────── */
    .tree-node.drop-target {
      background: var(--vscode-list-dropBackground, rgba(83, 89, 93, 0.5));
    }
    .tree-node.dragging {
      opacity: 0.4;
    }
    .drag-image {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--vscode-list-activeSelectionBackground, #094771);
      color: var(--vscode-list-activeSelectionForeground, #fff);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      white-space: nowrap;
      pointer-events: none;
    }
    .drag-image .icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .drag-image .label {
      color: inherit;
    }
    /* ── Sash (resize handle between sections) ─────────────────── */
    .sash {
      height: 0;
      position: absolute;
      left: 0;
      right: 0;
      z-index: 1;
    }
    .sash::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: -3px;
      height: 6px;
      cursor: ns-resize;
    }
    .sash.inactive::after {
      cursor: default;
      pointer-events: none;
    }
    .sash:not(.inactive):hover::after,
    .sash.active::after {
      top: 0;
      height: 1px;
      background: #fff676;
    }
    body.sash-dragging {
      cursor: ns-resize !important;
    }
    body.sash-dragging * {
      user-select: none !important;
    }
    .tree-section-label {
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 6px 8px 4px 2px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
      font-weight: 600;
      flex-shrink: 0;
    }
    .tree-section-label:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-section-label .section-chevron {
      width: 16px;
      height: 16px;
      margin-right: 4px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: transform 0.15s ease;
    }
    .tree-section-label .section-chevron.expanded {
      transform: rotate(90deg);
    }
    .tree-section-label .section-title {
      flex: 1;
    }
    .tree-section-label .section-add-btn {
      width: 20px;
      height: 20px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 14px;
      font-weight: 300;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .tree-section-label:hover .section-add-btn {
      opacity: 1;
    }
    .section-add-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .fleet-section-label {
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 6px 8px 4px 2px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
      font-weight: 600;
      flex-shrink: 0;
    }
    .fleet-section-label:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .fleet-section-label .fleet-chevron {
      width: 16px;
      height: 16px;
      margin-right: 4px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: transform 0.15s ease;
    }
    .fleet-section-label .fleet-chevron.expanded {
      transform: rotate(90deg);
    }
    .fleet-body {
      padding: 8px 12px 8px 32px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .context-menu {
      position: fixed;
      z-index: 1000;
      min-width: 180px;
      background: var(--vscode-menu-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      font-size: 12px;
    }
    .context-menu-item {
      padding: 4px 12px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      white-space: nowrap;
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
    }
    .context-menu-separator {
      height: 1px;
      margin: 4px 0;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }

    /* Inline editing — VS Code explorer-style */
    .inline-edit-input {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      background: var(--vscode-input-background, transparent);
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      outline: none;
      padding: 0 2px;
      margin: 0;
      height: 22px;
      line-height: 22px;
      box-sizing: border-box;
      flex: 1;
      min-width: 0;
    }
    .inline-edit-input.inline-error {
      border-color: var(--vscode-inputValidation-errorBorder, #f44);
    }
    .inline-edit-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }
  </style>
</head>
<body>
  <div class="sidebar-header">
    <button class="btn-chat" id="btn-chat"><svg class="btn-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none"><rect x="1" y="2" width="14" height="10" rx="3" fill="#fff676"/><polygon points="5,12 8,12 5,15" fill="#fff676"/><path d="M5 6.5h6M5 9h4" stroke="#111" stroke-width="1.2" stroke-linecap="round"/></svg>Chat with Amico</button>
    <button class="btn-new-project" id="btn-new-project">+ New Project</button>
  </div>
  <div class="sidebar-sections">
    <div id="tree-root"></div>
    <div id="fleet-section" class="section" data-section-key="fleet">
      <div class="fleet-section-label" id="fleet-toggle">
        <span class="fleet-chevron" id="fleet-chevron">&#8250;</span>
        <span>Fleet</span>
      </div>
      <div class="fleet-body section-body" id="fleet-body" style="display:none;">Coming soon</div>
    </div>
  </div>
  <script nonce="${nonce}">window.__iconTheme = ${iconThemeJson};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── Helpers (extension host, Node runtime) ───────────────────────────────────

/** Read research-project.toml fields. Returns {} on any failure. */
function readResearchToml(dir: string): { name?: string; status?: string } {
  try {
    const tomlPath = path.join(dir, "research-project.toml");
    const content = fs.readFileSync(tomlPath, "utf8");
    // Minimal TOML key extraction (no full parser dependency — only name/status).
    const name = content.match(/^\s*name\s*=\s*"([^"]*)"/m)?.[1];
    const status = content.match(/^\s*status\s*=\s*"([^"]*)"/m)?.[1];
    return { name, status };
  } catch {
    return {};
  }
}

/** Read directory entries via Node fs. */
async function readDirectoryEntries(dir: string): Promise<RawDirEntry[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.map(([name, type]) => ({
      name,
      type: type === vscode.FileType.Directory ? "directory" as const : "file" as const,
    }));
  } catch {
    return [];
  }
}

/** Get exclude patterns from files.exclude config. */
function getExcludePatterns(): string[] {
  const exclude = vscode.workspace
    .getConfiguration("files")
    .get<Record<string, boolean>>("exclude", {});
  return Object.entries(exclude)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\//g, ""));
}

/** Cryptographically random nonce for CSP script-src. */
function getNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** Open a folder picker and add selected folder(s) to the workspace. */
async function addExistingProject(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: true,
    openLabel: "Add to Workspace",
    title: "Select project folder(s) to add",
  });
  if (!uris || uris.length === 0) return;

  const existing = vscode.workspace.workspaceFolders ?? [];
  const start = existing.length;
  vscode.workspace.updateWorkspaceFolders(
    start,
    0,
    ...uris.map((uri) => ({ uri })),
  );
}

// ── Git status annotation ────────────────────────────────────────────────────

/** Classify a numeric Git extension status into a simple category. */
function classifyGitStatus(status: number): TreeEntry["gitStatus"] {
  // Git extension Status enum: 0=INDEX_MODIFIED, 1=INDEX_ADDED, 2=INDEX_DELETED,
  // 3=INDEX_RENAMED, 4=INDEX_COPIED, 5=MODIFIED, 6=DELETED, 7=UNTRACKED,
  // 8=IGNORED, 9=INTENT_TO_ADD, 10..16=merge conflict variants
  switch (status) {
    case 0: case 3: case 4: case 5: return "modified";
    case 1: case 9: return "added";
    case 2: case 6: return "deleted";
    case 7: return "untracked";
    case 8: return "ignored";
    default: return "conflict";
  }
}

/**
 * Pure function: build a path → git-status record from the Git extension API.
 * Working-tree changes take precedence over index (staged) changes for the same path.
 * Exported for testing and for the reactive git-status push.
 */
export function buildGitStatusMap(api: any): Record<string, string> {
  const map: Record<string, string> = {};
  for (const repo of api.repositories ?? []) {
    const state = repo?.state;
    if (!state) continue;
    for (const change of state.workingTreeChanges ?? []) {
      map[change.uri.fsPath] = classifyGitStatus(change.status);
    }
    // Index changes (staged) — working tree takes precedence
    for (const change of state.indexChanges ?? []) {
      if (!map[change.uri.fsPath]) {
        map[change.uri.fsPath] = classifyGitStatus(change.status);
      }
    }
  }
  return map;
}

/**
 * Annotate tree entries with git status from the Git extension.
 * Falls back gracefully if the git extension is unavailable.
 */
function annotateGitStatus(entries: TreeEntry[]): TreeEntry[] {
  try {
    const gitExt = vscode.extensions.getExtension("vscode.git");
    if (!gitExt?.isActive) return entries;
    const api = gitExt.exports?.getAPI?.(1);
    if (!api) return entries;

    const statusRecord = buildGitStatusMap(api);
    if (Object.keys(statusRecord).length === 0) return entries;

    const statusMap = new Map(Object.entries(statusRecord));

    // Annotate files with exact matches, then propagate to directories
    const annotated = entries.map((entry) => {
      const gitStatus = statusMap.get(entry.path);
      return gitStatus ? { ...entry, gitStatus } : entry;
    });
    return propagateGitStatusToDirs(annotated, statusMap);
  } catch {
    return entries;
  }
}

/** Priority rank for git statuses (higher = more notable). */
const GIT_STATUS_PRIORITY: Record<string, number> = {
  conflict: 5, modified: 4, deleted: 3, untracked: 2, added: 1, ignored: 0,
};

/**
 * Pure function: propagate git status to directory entries.
 * A directory inherits the "most notable" status from any changed file
 * whose path starts with the directory's path. This matches the VS Code
 * explorer's behavior where parent folders turn yellow when children change.
 */
export function propagateGitStatusToDirs(
  entries: TreeEntry[],
  statusMap: Map<string, string>,
): TreeEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "directory" || entry.gitStatus) return entry;

    let bestStatus: string | undefined;
    let bestPriority = -1;
    const prefix = entry.path + "/";

    for (const [filePath, status] of statusMap) {
      if (filePath.startsWith(prefix)) {
        const p = GIT_STATUS_PRIORITY[status] ?? 0;
        if (p > bestPriority) {
          bestPriority = p;
          bestStatus = status;
        }
      }
    }

    return bestStatus ? { ...entry, gitStatus: bestStatus as TreeEntry["gitStatus"] } : entry;
  });
}

// ── File operations (extension host, #676) ───────────────────────────────────

/**
 * Execute a file operation dispatched from the webview context menu.
 * All operations go through vscode.workspace.fs — the webview never touches
 * the filesystem directly. Delete always uses useTrash: true.
 *
 * Operations that need user input (new-file, new-folder, rename) collect it
 * via vscode.window.showInputBox on the host side — window.prompt() does not
 * work in VS Code webview iframes.
 */
async function executeFileOp(req: FileOpRequest): Promise<FileOpResult> {
  try {
    const uri = vscode.Uri.file(req.path);

    switch (req.op) {
      case "new-file": {
        const name = req.name ?? await vscode.window.showInputBox({
          prompt: "File name",
          placeHolder: "filename.ext",
        });
        if (!name) return { ok: true }; // User cancelled
        const newUri = vscode.Uri.joinPath(uri, name);
        await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
        void vscode.window.showTextDocument(newUri);
        return { ok: true };
      }
      case "new-folder": {
        const name = req.name ?? await vscode.window.showInputBox({
          prompt: "Folder name",
          placeHolder: "folder-name",
        });
        if (!name) return { ok: true }; // User cancelled
        const newUri = vscode.Uri.joinPath(uri, name);
        await vscode.workspace.fs.createDirectory(newUri);
        return { ok: true };
      }
      case "rename": {
        const currentName = path.basename(req.path);
        const dotIdx = currentName.lastIndexOf(".");
        const selEnd = dotIdx > 0 ? dotIdx : currentName.length;
        const newName = req.newName ?? await vscode.window.showInputBox({
          prompt: "Rename to:",
          value: currentName,
          valueSelection: [0, selEnd],
        });
        if (!newName || newName === currentName) return { ok: true };
        const dir = vscode.Uri.file(path.dirname(req.path));
        const newUri = vscode.Uri.joinPath(dir, newName);
        // Check for collision
        try {
          await vscode.workspace.fs.stat(newUri);
          return { ok: false, message: `"${newName}" already exists` };
        } catch {
          // Target doesn't exist — safe to rename
        }
        await vscode.workspace.fs.rename(uri, newUri);
        return { ok: true };
      }
      case "move": {
        if (!req.targetDir) return { ok: false, message: "No target directory" };
        const sourceName = path.basename(req.path);
        const targetUri = vscode.Uri.joinPath(vscode.Uri.file(req.targetDir), sourceName);
        // Check for collision
        try {
          await vscode.workspace.fs.stat(targetUri);
          return { ok: false, message: `"${sourceName}" already exists in target directory` };
        } catch {
          // Target doesn't exist — safe to move
        }
        await vscode.workspace.fs.rename(uri, targetUri);
        return { ok: true };
      }
      case "delete": {
        // Always trash — the permanent delete path does not exist (#673 invariant)
        await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: true });
        return { ok: true };
      }
      case "copy-path": {
        await vscode.env.clipboard.writeText(uri.fsPath);
        return { ok: true };
      }
      case "copy-relative-path": {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
        await vscode.env.clipboard.writeText(rel);
        return { ok: true };
      }
      case "reveal-in-os": {
        await vscode.commands.executeCommand("revealFileInOS", uri);
        return { ok: true };
      }
      case "open-in-terminal": {
        const terminal = vscode.window.createTerminal({ cwd: uri.fsPath });
        terminal.show();
        return { ok: true };
      }
      case "open-to-side": {
        await vscode.commands.executeCommand("vscode.open", uri, vscode.ViewColumn.Beside);
        return { ok: true };
      }
      case "remove-from-workspace": {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const idx = folders.findIndex((f) => f.uri.fsPath === req.path);
        if (idx >= 0) {
          vscode.workspace.updateWorkspaceFolders(idx, 1);
        }
        return { ok: true };
      }
      case "new-session": {
        // Posts to the session creation flow — the project path is carried
        void vscode.commands.executeCommand("amicode.newChat");
        return { ok: true };
      }
      default:
        return { ok: false, message: `Unknown operation: ${req.op}` };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
