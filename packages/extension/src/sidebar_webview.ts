// sidebar_webview.ts — Browser entry point for the sidebar webview (#673).
// Runs inside the webview iframe (platform: browser, format: iife).
// Acquires the VS Code API and wires button clicks + tree rendering to bridge.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface TreeRoot {
  path: string;
  name: string;
  projectType: "research" | "dev";
  metadata?: { phase?: string; lastActive?: string };
}

interface TreeEntry {
  name: string;
  type: "file" | "directory";
  path: string;
  gitStatus?: string;
}

// ── Icon theme data (embedded by the host in window.__iconTheme) ─────────────

interface IconThemeData {
  mode: "font" | "svg" | "none";
  css: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folder: string;
  folderExpanded: string;
  defaultFile: string;
}

const iconTheme: IconThemeData = (window as any).__iconTheme ?? {
  mode: "none", css: "", fileExtensions: {}, fileNames: {},
  folder: "", folderExpanded: "", defaultFile: "",
};

/** Resolve a file name to an icon identifier from the theme. */
function resolveFileIcon(name: string): string {
  // Exact file name match first
  if (iconTheme.fileNames[name]) return iconTheme.fileNames[name];
  // Then extension match
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (iconTheme.fileExtensions[ext]) return iconTheme.fileExtensions[ext];
  }
  return iconTheme.defaultFile;
}

/** Create an icon element for a file based on the active icon theme. */
function createFileIconEl(name: string): HTMLElement {
  const icon = resolveFileIcon(name);
  return createIconEl(icon);
}

/** Create an icon element for a folder, or null if the theme has no folder icon. */
function createFolderIconEl(expanded: boolean): HTMLElement | null {
  const icon = expanded ? iconTheme.folderExpanded : iconTheme.folder;
  if (!icon) return null;
  return createIconEl(icon);
}

/** Build a DOM element for a theme icon (img for SVG mode, span for font mode). */
function createIconEl(icon: string): HTMLElement {
  if (iconTheme.mode === "svg" && icon) {
    const img = document.createElement("img");
    img.className = "icon";
    img.src = icon;
    img.width = 16;
    img.height = 16;
    return img;
  }
  if (iconTheme.mode === "font" && icon) {
    const span = document.createElement("span");
    span.className = `icon theme-icon ${icon}`;
    return span;
  }
  // No theme — empty spacer
  const span = document.createElement("span");
  span.className = "icon";
  return span;
}

// ── Main ─────────────────────────────────────────────────────────────────────

(function () {
  const vscode = acquireVsCodeApi();

  // Restore expanded state from webview state (survives hide/show).
  const savedState = vscode.getState() as { expanded?: Record<string, boolean> } | undefined;
  const expanded: Record<string, boolean> = savedState?.expanded ?? {};

  function saveExpandedState(): void {
    vscode.setState({ expanded });
  }

  // ── Button wiring ──────────────────────────────────────────────────────────

  const chatBtn = document.getElementById("btn-chat");
  const newProjectBtn = document.getElementById("btn-new-project");
  const treeRoot = document.getElementById("tree-root");

  chatBtn?.addEventListener("click", () => {
    vscode.postMessage({ kind: "open-chat" });
  });

  newProjectBtn?.addEventListener("click", () => {
    vscode.postMessage({ kind: "new-project" });
  });

  // ── Fleet section toggle ──────────────────────────────────────────────────

  const fleetToggle = document.getElementById("fleet-toggle");
  const fleetChevron = document.getElementById("fleet-chevron");
  const fleetBody = document.getElementById("fleet-body");
  const fleetSection = document.getElementById("fleet-section");
  let fleetExpanded = false;

  fleetToggle?.addEventListener("click", () => {
    fleetExpanded = !fleetExpanded;
    if (fleetChevron) fleetChevron.textContent = fleetExpanded ? "\u25BE" : "\u25B8"; // ▾ / ▸
    if (fleetBody) fleetBody.style.display = fleetExpanded ? "block" : "none";
    fleetSection?.classList.toggle("expanded", fleetExpanded);
    resetSectionSizes();
  });

  // ── Inline editing (VS Code explorer-style) ────────────────────────────────

  let activeInlineEdit: {
    input: HTMLInputElement;
    mode: "rename" | "new-file" | "new-folder";
    path: string;
    originalLabel?: string;          // for rename: the label text before editing
    labelEl?: HTMLElement;           // for rename: the original .label span
    tempRow?: HTMLElement;           // for new-file/new-folder: the temporary row
    committed?: boolean;             // set to true when Enter fires, prevents blur from double-cancelling
  } | null = null;

  function cancelInlineEdit(): void {
    if (!activeInlineEdit) return;
    const edit = activeInlineEdit;
    activeInlineEdit = null;

    if (edit.mode === "rename" && edit.labelEl && edit.originalLabel != null) {
      // Restore the original label
      edit.labelEl.textContent = edit.originalLabel;
      edit.labelEl.style.display = "";
      edit.input.remove();
    } else if (edit.tempRow) {
      // Remove the temporary row
      edit.tempRow.remove();
    }
  }

  function commitInlineEdit(): void {
    if (!activeInlineEdit) return;
    const edit = activeInlineEdit;
    const value = edit.input.value.trim();

    // Validation: reject empty names and path separators
    if (value.length === 0 || value.includes("/") || value.includes("\\")) {
      edit.input.classList.add("inline-error");
      edit.input.focus();
      return;
    }

    edit.committed = true;

    if (edit.mode === "rename") {
      vscode.postMessage({ kind: "file-op", op: "rename", path: edit.path, newName: value });
    } else if (edit.mode === "new-file") {
      vscode.postMessage({ kind: "file-op", op: "new-file", path: edit.path, name: value });
    } else if (edit.mode === "new-folder") {
      vscode.postMessage({ kind: "file-op", op: "new-folder", path: edit.path, name: value });
    }
  }

  function startInlineEdit(
    mode: "rename" | "new-file" | "new-folder",
    nodePath: string,
    dataEl: HTMLElement,
  ): void {
    // Cancel any existing inline edit first
    cancelInlineEdit();

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitInlineEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelInlineEdit();
      }
    });

    input.addEventListener("blur", () => {
      // If not committed, treat blur as cancel
      if (activeInlineEdit && !activeInlineEdit.committed) {
        cancelInlineEdit();
      }
    });

    if (mode === "rename") {
      const row = dataEl.querySelector(".tree-node") ?? dataEl;
      const labelEl = row.querySelector(".label") as HTMLElement | null;
      if (!labelEl) return;

      const currentName = labelEl.textContent ?? "";
      input.value = currentName;

      // Select the stem (not the extension), like VS Code
      const dotIdx = currentName.lastIndexOf(".");
      const selEnd = dotIdx > 0 ? dotIdx : currentName.length;

      activeInlineEdit = {
        input,
        mode,
        path: nodePath,
        originalLabel: currentName,
        labelEl,
      };

      // Hide the label and insert the input in its place
      labelEl.style.display = "none";
      labelEl.parentElement!.appendChild(input);
      input.focus();
      input.setSelectionRange(0, selEnd);

    } else {
      // new-file or new-folder — create a temporary row at the top of the directory's children
      // First, ensure the directory is expanded
      if (!expanded[nodePath]) {
        expanded[nodePath] = true;
        saveExpandedState();
        const chevronSpan = dataEl.querySelector(".chevron") as HTMLElement | null;
        if (chevronSpan) chevronSpan.textContent = "\u25BE";
        const iconSpan = dataEl.querySelector(".icon") as HTMLElement | null;
        if (iconSpan) {
          const newIcon = createFolderIconEl(true);
          if (newIcon) iconSpan.replaceWith(newIcon);
        }
        const childrenEl = dataEl.querySelector(".children") as HTMLElement | null;
        if (childrenEl) {
          childrenEl.style.display = "block";
          if (!childrenCache[nodePath]) {
            vscode.postMessage({ kind: "get-children", path: nodePath });
          }
        }
      }

      const childrenEl = dataEl.querySelector(".children") as HTMLElement | null;
      if (!childrenEl) return;

      // Compute depth from the parent row's padding
      const parentRow = dataEl.querySelector(".tree-node") as HTMLElement | null;
      const parentPad = parseInt(parentRow?.style.paddingLeft ?? "8");
      const depth = Math.round((parentPad - 8) / 16) + 1;

      const tempRow = document.createElement("div");
      tempRow.className = "tree-node inline-edit-row";
      tempRow.style.paddingLeft = `${8 + depth * 16}px`;

      // Add the appropriate icon
      if (mode === "new-folder") {
        const folderIcon = createFolderIconEl(false);
        if (folderIcon) tempRow.appendChild(folderIcon);
      } else {
        const fileIcon = createFileIconEl("untitled");
        tempRow.appendChild(fileIcon);
      }

      tempRow.appendChild(input);

      activeInlineEdit = {
        input,
        mode,
        path: nodePath,
        tempRow,
      };

      // Insert at the top of the children list
      if (childrenEl.firstChild) {
        childrenEl.insertBefore(tempRow, childrenEl.firstChild);
      } else {
        childrenEl.appendChild(tempRow);
      }

      input.focus();
    }
  }

  // ── Context menu ──────────────────────────────────────────────────────────

  let activeMenu: HTMLElement | null = null;

  function dismissMenu(): void {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  document.addEventListener("click", dismissMenu);
  document.addEventListener("contextmenu", (e) => {
    // Suppress context menu while inline edit is active
    if (activeInlineEdit) return;

    // Only handle right-clicks on tree nodes (not buttons, fleet, etc.)
    const target = e.target as HTMLElement;
    const treeNode = target.closest(".tree-node") as HTMLElement | null;
    if (!treeNode) return;

    e.preventDefault();
    dismissMenu();

    // Resolve the data element — for files data-path is on the tree-node itself;
    // for directories it's on the parent container wrapping .tree-node + .children.
    const dataEl = treeNode.dataset.path ? treeNode : treeNode.parentElement;
    const nodePath = dataEl?.dataset.path;
    const nodeType = dataEl?.dataset.type; // "file" or "directory"
    if (!nodePath) return;

    // Determine if this is a workspace root
    const isRoot = currentRoots.some((r) => r.path === nodePath);

    // Build menu items
    interface MenuItem { label: string; op?: string; separator?: boolean; inline?: boolean }
    const items: MenuItem[] = [];

    if (nodeType === "directory") {
      items.push({ label: "New File", op: "new-file", inline: true });
      items.push({ label: "New Folder", op: "new-folder", inline: true });
      items.push({ separator: true });
    }

    items.push({ label: "Rename", op: "rename", inline: true });
    items.push({ label: "Delete", op: "delete" });
    items.push({ separator: true });
    items.push({ label: "Copy Path", op: "copy-path" });
    items.push({ label: "Copy Relative Path", op: "copy-relative-path" });
    items.push({ separator: true });
    items.push({ label: "Reveal in Finder", op: "reveal-in-os" });
    items.push({ label: "Open in Terminal", op: "open-in-terminal" });

    if (nodeType === "file") {
      items.push({ label: "Open to the Side", op: "open-to-side" });
    }

    if (isRoot) {
      items.push({ separator: true });
      items.push({ label: "Remove from Workspace", op: "remove-from-workspace" });
    }

    // Render menu
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menu.appendChild(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.label;
      el.addEventListener("click", () => {
        dismissMenu();
        if (item.inline && dataEl) {
          // Inline edit: rename, new-file, new-folder
          startInlineEdit(item.op as "rename" | "new-file" | "new-folder", nodePath, dataEl);
        } else {
          vscode.postMessage({ kind: "file-op", op: item.op, path: nodePath });
        }
      });
      menu.appendChild(el);
    }

    document.body.appendChild(menu);
    activeMenu = menu;

    // Clamp to viewport bounds
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });

  // ── Drag and drop ─────────────────────────────────────────────────────────

  let dragSourcePath: string | null = null;
  let currentDropTarget: HTMLElement | null = null;

  function clearDropTarget(): void {
    if (currentDropTarget) {
      currentDropTarget.classList.remove("drop-target");
      currentDropTarget = null;
    }
  }

  // ── Sash resize between sections ────────────────────────────────────────────

  const MIN_SECTION_HEIGHT = 28; // ~section header height
  const sidebarSections = document.querySelector(".sidebar-sections");
  let activeSash: {
    sash: HTMLElement;
    above: HTMLElement;
    below: HTMLElement;
    startY: number;
    startAboveH: number;
    startBelowH: number;
  } | null = null;

  /** Collect all .section elements in visual order (tree-root has display:contents). */
  function getAllSections(): HTMLElement[] {
    const sections: HTMLElement[] = [];
    if (treeRoot) {
      for (const child of Array.from(treeRoot.children)) {
        if ((child as HTMLElement).classList?.contains("section")) {
          sections.push(child as HTMLElement);
        }
      }
    }
    if (fleetSection) sections.push(fleetSection);
    return sections;
  }

  /** Remove old sashes and insert fresh ones between adjacent sections. */
  function updateSashes(): void {
    document.querySelectorAll(".sash").forEach((s) => s.remove());
    const sections = getAllSections();
    for (let i = 0; i < sections.length - 1; i++) {
      const above = sections[i];
      const below = sections[i + 1];
      const sash = document.createElement("div");
      sash.className = "sash";

      // Active only when both neighbours are expanded
      const setActive = () => {
        const bothExpanded = above.classList.contains("expanded") && below.classList.contains("expanded");
        sash.classList.toggle("inactive", !bothExpanded);
      };
      setActive();
      (sash as any)._setActive = setActive;

      sash.addEventListener("mousedown", (e) => {
        if (sash.classList.contains("inactive")) return;
        e.preventDefault();
        activeSash = {
          sash, above, below,
          startY: e.clientY,
          startAboveH: above.getBoundingClientRect().height,
          startBelowH: below.getBoundingClientRect().height,
        };
        sash.classList.add("active");
        document.body.classList.add("sash-dragging");
      });

      // Insert after the 'above' section in the DOM
      above.parentElement!.insertBefore(sash, above.nextSibling);
    }
  }

  /** Clear explicit sizes so CSS flex:1 re-distributes equally; refresh sash states. */
  function resetSectionSizes(): void {
    for (const el of getAllSections()) {
      el.style.flex = "";
    }
    document.querySelectorAll(".sash").forEach((s) => {
      (s as any)._setActive?.();
    });
  }

  // Global mousemove / mouseup for sash dragging
  document.addEventListener("mousemove", (e) => {
    if (!activeSash) return;
    const { above, below, startY, startAboveH, startBelowH } = activeSash;
    const delta = e.clientY - startY;
    const total = startAboveH + startBelowH;
    const newAbove = Math.max(MIN_SECTION_HEIGHT, Math.min(startAboveH + delta, total - MIN_SECTION_HEIGHT));
    const newBelow = total - newAbove;
    above.style.flex = `0 0 ${newAbove}px`;
    below.style.flex = `0 0 ${newBelow}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!activeSash) return;
    activeSash.sash.classList.remove("active");
    document.body.classList.remove("sash-dragging");
    activeSash = null;
  });

  // ── Tree rendering ─────────────────────────────────────────────────────────

  let currentRoots: TreeRoot[] = [];
  // Cache children per directory path
  const childrenCache: Record<string, TreeEntry[]> = {};

  // Restore section expanded state (separate from tree node expanded state)
  const sectionExpanded: Record<string, boolean> = savedState?.expanded
    ? { research: savedState.expanded["__section_research"] !== false, dev: savedState.expanded["__section_dev"] !== false }
    : { research: true, dev: true };

  function saveSectionState(): void {
    expanded["__section_research"] = sectionExpanded.research;
    expanded["__section_dev"] = sectionExpanded.dev;
    saveExpandedState();
  }

  function renderSectionHeader(title: string, sectionKey: string): { section: HTMLElement; body: HTMLElement } {
    const section = document.createElement("div");
    section.className = sectionExpanded[sectionKey] ? "section expanded" : "section";

    const header = document.createElement("div");
    header.className = "tree-section-label";

    const chevron = document.createElement("span");
    chevron.className = "section-chevron";
    chevron.textContent = sectionExpanded[sectionKey] ? "\u25BE" : "\u25B8"; // ▾ / ▸

    const titleEl = document.createElement("span");
    titleEl.className = "section-title";
    titleEl.textContent = title;

    const addBtn = document.createElement("button");
    addBtn.className = "section-add-btn";
    addBtn.textContent = "+";
    addBtn.title = "Add existing project";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "add-existing" });
    });

    header.appendChild(chevron);
    header.appendChild(titleEl);
    header.appendChild(addBtn);

    const body = document.createElement("div");
    body.className = "section-body";
    body.style.display = sectionExpanded[sectionKey] ? "block" : "none";

    section.appendChild(header);
    section.appendChild(body);

    header.addEventListener("click", () => {
      sectionExpanded[sectionKey] = !sectionExpanded[sectionKey];
      saveSectionState();
      chevron.textContent = sectionExpanded[sectionKey] ? "\u25BE" : "\u25B8";
      body.style.display = sectionExpanded[sectionKey] ? "block" : "none";
      section.classList.toggle("expanded", sectionExpanded[sectionKey]);
      resetSectionSizes();
    });

    return { section, body };
  }

  function renderRoots(roots: TreeRoot[]): void {
    if (!treeRoot) return;
    currentRoots = roots;
    treeRoot.innerHTML = "";

    // Group: research first, then dev
    const research = roots.filter((r) => r.projectType === "research");
    const dev = roots.filter((r) => r.projectType === "dev");

    if (research.length > 0) {
      const { section, body } = renderSectionHeader("Research Projects", "research");
      for (const root of research) {
        body.appendChild(renderRootNode(root, 0));
      }
      treeRoot.appendChild(section);
    }

    if (dev.length > 0) {
      const { section, body } = renderSectionHeader("Development Projects", "dev");
      for (const root of dev) {
        body.appendChild(renderRootNode(root, 0));
      }
      treeRoot.appendChild(section);
    }

    updateSashes();
  }

  function renderRootNode(root: TreeRoot, depth: number): HTMLElement {
    const container = document.createElement("div");
    container.dataset.path = root.path;
    container.dataset.type = "directory";

    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.paddingLeft = `${8 + depth * 16}px`;

    // Chevron (expand/collapse indicator)
    const chevronEl = document.createElement("span");
    chevronEl.className = "chevron";
    chevronEl.textContent = expanded[root.path] ? "\u25BE" : "\u25B8"; // ▾ / ▸

    // Folder icon (omitted if theme has none — label sits next to chevron)
    const iconEl = createFolderIconEl(!!expanded[root.path]);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = root.name;

    row.appendChild(chevronEl);
    if (iconEl) row.appendChild(iconEl);
    row.appendChild(label);

    // Research metadata pill
    if (root.projectType === "research" && root.metadata?.phase) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = root.metadata.phase;
      row.appendChild(pill);
    }

    container.appendChild(row);

    // Drag-and-drop: roots are drop targets
    setupDirectoryDropTarget(row, root.path);

    // Children container
    const childrenEl = document.createElement("div");
    childrenEl.className = "children";
    childrenEl.style.display = expanded[root.path] ? "block" : "none";
    container.appendChild(childrenEl);

    // If already expanded and cached, render children
    if (expanded[root.path] && childrenCache[root.path]) {
      renderChildren(childrenEl, childrenCache[root.path], depth + 1);
    }

    row.addEventListener("click", () => {
      expanded[root.path] = !expanded[root.path];
      saveExpandedState();
      chevronEl.textContent = expanded[root.path] ? "\u25BE" : "\u25B8";
      if (iconEl) {
        const newIcon = createFolderIconEl(expanded[root.path]);
        if (newIcon) row.replaceChild(newIcon, row.querySelector(".icon")!);
      }
      childrenEl.style.display = expanded[root.path] ? "block" : "none";

      if (expanded[root.path] && !childrenCache[root.path]) {
        vscode.postMessage({ kind: "get-children", path: root.path });
      }
    });

    // Request children on initial render if expanded (for restore)
    if (expanded[root.path] && !childrenCache[root.path]) {
      vscode.postMessage({ kind: "get-children", path: root.path });
    }

    return container;
  }

  function renderChildren(container: HTMLElement, entries: TreeEntry[], depth: number): void {
    container.innerHTML = "";

    for (const entry of entries) {
      if (entry.type === "directory") {
        container.appendChild(renderDirectoryNode(entry, depth));
      } else {
        container.appendChild(renderFileNode(entry, depth));
      }
    }
  }

  function renderDirectoryNode(entry: TreeEntry, depth: number): HTMLElement {
    const container = document.createElement("div");
    container.dataset.path = entry.path;
    container.dataset.type = "directory";

    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.draggable = true;

    // Chevron
    const chevronEl = document.createElement("span");
    chevronEl.className = "chevron";
    chevronEl.textContent = expanded[entry.path] ? "\u25BE" : "\u25B8";

    // Folder icon (omitted if theme has none)
    const iconEl = createFolderIconEl(!!expanded[entry.path]);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;
    if (entry.gitStatus) {
      label.classList.add(`git-${entry.gitStatus}`);
    }

    row.appendChild(chevronEl);
    if (iconEl) row.appendChild(iconEl);
    row.appendChild(label);
    container.appendChild(row);

    // Drag-and-drop: directories are both draggable sources and drop targets
    setupDragSource(row, entry.path);
    setupDirectoryDropTarget(row, entry.path);

    const childrenEl = document.createElement("div");
    childrenEl.className = "children";
    childrenEl.style.display = expanded[entry.path] ? "block" : "none";
    container.appendChild(childrenEl);

    if (expanded[entry.path] && childrenCache[entry.path]) {
      renderChildren(childrenEl, childrenCache[entry.path], depth + 1);
    }

    row.addEventListener("click", () => {
      expanded[entry.path] = !expanded[entry.path];
      saveExpandedState();
      chevronEl.textContent = expanded[entry.path] ? "\u25BE" : "\u25B8";
      if (iconEl) {
        const newIcon = createFolderIconEl(expanded[entry.path]);
        if (newIcon) row.replaceChild(newIcon, row.querySelector(".icon")!);
      }
      childrenEl.style.display = expanded[entry.path] ? "block" : "none";

      if (expanded[entry.path] && !childrenCache[entry.path]) {
        vscode.postMessage({ kind: "get-children", path: entry.path });
      }
    });

    if (expanded[entry.path] && !childrenCache[entry.path]) {
      vscode.postMessage({ kind: "get-children", path: entry.path });
    }

    return container;
  }

  function renderFileNode(entry: TreeEntry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-node";
    row.dataset.path = entry.path;
    row.dataset.type = "file";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    row.draggable = true;

    // File icon (from active theme) — sits where the chevron would be
    const iconEl = createFileIconEl(entry.name);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;
    if (entry.gitStatus) {
      label.classList.add(`git-${entry.gitStatus}`);
    }

    row.appendChild(iconEl);
    row.appendChild(label);

    // Drag source
    setupDragSource(row, entry.path);

    row.addEventListener("click", () => {
      vscode.postMessage({ kind: "open-file", path: entry.path });
    });

    return row;
  }

  // ── Drag-and-drop helpers ─────────────────────────────────────────────────

  function setupDragSource(el: HTMLElement, sourcePath: string): void {
    el.addEventListener("dragstart", (e) => {
      dragSourcePath = sourcePath;
      el.classList.add("dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", sourcePath);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      dragSourcePath = null;
      clearDropTarget();
    });
  }

  function setupDirectoryDropTarget(el: HTMLElement, targetDir: string): void {
    el.addEventListener("dragover", (e) => {
      if (!dragSourcePath) return;
      // Don't allow dropping on self or on a parent of the source
      if (dragSourcePath === targetDir) return;
      if (dragSourcePath.startsWith(targetDir + "/")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (currentDropTarget !== el) {
        clearDropTarget();
        currentDropTarget = el;
        el.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", (e) => {
      // Only clear if we're really leaving (not entering a child)
      const related = e.relatedTarget as HTMLElement | null;
      if (related && el.contains(related)) return;
      if (currentDropTarget === el) {
        clearDropTarget();
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropTarget();
      const sourcePath = e.dataTransfer?.getData("text/plain");
      if (!sourcePath || sourcePath === targetDir) return;
      vscode.postMessage({ kind: "file-op", op: "move", path: sourcePath, targetDir });
    });
  }

  // ── Host → Webview messages ────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.kind !== "string") return;

    switch (msg.kind) {
      case "chat-active":
        if (chatBtn) {
          chatBtn.classList.toggle("muted", !!msg.active);
        }
        break;

      case "roots":
        renderRoots(msg.roots ?? []);
        break;

      case "children": {
        childrenCache[msg.path] = msg.entries ?? [];
        // Find the container for this path and render children
        const container = treeRoot?.querySelector(`[data-path="${CSS.escape(msg.path)}"] > .children`);
        if (container) {
          const depth = Math.round((parseInt((container.parentElement as HTMLElement)?.querySelector('.tree-node')?.style.paddingLeft ?? '8') - 8) / 16) + 1;
          renderChildren(container as HTMLElement, msg.entries ?? [], depth);
          // Re-insert the inline edit temp row if one is active for this directory
          if (activeInlineEdit?.tempRow && activeInlineEdit.path === msg.path) {
            container.insertBefore(activeInlineEdit.tempRow, container.firstChild);
            activeInlineEdit.input.focus();
          }
        }
        break;
      }

      case "fs-changed": {
        // Invalidate cache for the changed folder and re-request if expanded
        const folder = msg.folder;
        for (const key of Object.keys(childrenCache)) {
          if (key === folder || key.startsWith(folder + "/")) {
            delete childrenCache[key];
          }
        }
        // Re-request roots (workspace may have changed project type)
        vscode.postMessage({ kind: "get-roots" });
        // Re-request children for expanded nodes under this folder
        for (const key of Object.keys(expanded)) {
          if (expanded[key] && (key === folder || key.startsWith(folder + "/"))) {
            vscode.postMessage({ kind: "get-children", path: key });
          }
        }
        break;
      }

      case "active-project": {
        // Update highlight: find all root nodes, toggle the "active" class
        const activePath: string | null = msg.path;
        const allRootNodes = treeRoot?.querySelectorAll("[data-path][data-type='directory']") ?? [];
        for (const node of allRootNodes) {
          const el = node as HTMLElement;
          const nodePath = el.dataset.path;
          const row = el.querySelector(".tree-node") as HTMLElement | null;
          if (!row) continue;

          if (nodePath === activePath) {
            row.style.borderLeft = "2px solid var(--vscode-focusBorder)";
            row.style.background = "var(--vscode-list-activeSelectionBackground)";
            // Auto-expand the active project root (not deeper)
            if (!expanded[nodePath!]) {
              expanded[nodePath!] = true;
              saveExpandedState();
              const chevronSpan = row.querySelector(".chevron") as HTMLElement | null;
              if (chevronSpan) chevronSpan.textContent = "\u25BE";
              const iconSpan = row.querySelector(".icon") as HTMLElement | null;
              if (iconSpan) {
                const newIcon = createFolderIconEl(true);
                if (newIcon) iconSpan.replaceWith(newIcon);
              }
              const childrenEl = el.querySelector(".children") as HTMLElement | null;
              if (childrenEl) {
                childrenEl.style.display = "block";
                if (!childrenCache[nodePath!]) {
                  vscode.postMessage({ kind: "get-children", path: nodePath });
                }
              }
            }
          } else {
            row.style.borderLeft = "";
            row.style.background = "";
          }
        }
        break;
      }

      case "git-status": {
        // Reactive git coloring: walk all rendered nodes and apply/remove git classes.
        const statusMap: Record<string, string> = msg.statusMap ?? {};
        const gitClasses = ["git-modified", "git-added", "git-deleted", "git-untracked", "git-ignored", "git-conflict"];

        const allNodes = treeRoot?.querySelectorAll("[data-path]") ?? [];
        for (const node of allNodes) {
          const el = node as HTMLElement;
          const nodePath = el.dataset.path;
          if (!nodePath) continue;

          const label = el.querySelector(".tree-node .label") as HTMLElement | null;
          if (!label) continue;

          // Remove any existing git class
          for (const cls of gitClasses) label.classList.remove(cls);

          // Direct match (files)
          const directStatus = statusMap[nodePath];
          if (directStatus) {
            label.classList.add(`git-${directStatus}`);
            continue;
          }

          // Directory propagation: find the most notable child status
          const isDir = el.dataset.type === "directory";
          if (isDir) {
            const prefix = nodePath + "/";
            const statusPriority: Record<string, number> = {
              conflict: 5, modified: 4, deleted: 3, untracked: 2, added: 1, ignored: 0,
            };
            let bestStatus = "";
            let bestPri = -1;
            for (const [filePath, status] of Object.entries(statusMap)) {
              if (filePath.startsWith(prefix)) {
                const pri = statusPriority[status] ?? 0;
                if (pri > bestPri) {
                  bestPri = pri;
                  bestStatus = status;
                }
              }
            }
            if (bestStatus) {
              label.classList.add(`git-${bestStatus}`);
            }
          }
        }
        break;
      }

      case "file-op-ok": {
        // Inline edit succeeded — clean up the inline editor
        if (activeInlineEdit) {
          cancelInlineEdit();
        }
        break;
      }

      case "file-op-error": {
        // Inline edit failed — show error state on the input
        if (activeInlineEdit) {
          activeInlineEdit.input.classList.add("inline-error");
          activeInlineEdit.input.focus();
          // Clear error styling when user starts typing again
          const clearError = () => {
            activeInlineEdit?.input.classList.remove("inline-error");
            activeInlineEdit?.input.removeEventListener("input", clearError);
          };
          activeInlineEdit.input.addEventListener("input", clearError);
        }
        break;
      }
    }
  });

  // ── Initial load ───────────────────────────────────────────────────────────

  vscode.postMessage({ kind: "get-roots" });
})();
