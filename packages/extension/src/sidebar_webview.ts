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
    if (fleetChevron) fleetChevron.classList.toggle("expanded", fleetExpanded);
    if (fleetBody && fleetSection) {
      toggleSectionBody(fleetBody, fleetExpanded, fleetSection);
    }
  });

  // ── Inline editing (VS Code explorer-style) ────────────────────────────────

  // Suppresses the blur→cancel path while the children handler is re-rendering
  // a directory that holds the active inline edit's temp row. Without this,
  // innerHTML="" detaches the focused input → browser fires blur synchronously
  // → cancelInlineEdit nulls the state → the re-insert check sees null.
  let inlineEditRerendering = false;

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
      // If not committed, treat blur as cancel — unless we're in the middle
      // of a children re-render that will re-insert the temp row.
      if (inlineEditRerendering) return;
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
        if (chevronSpan) chevronSpan.classList.add("expanded");
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

  const HEADER_HEIGHT = 28; // collapsed section = header only
  const sidebarSections = document.querySelector(".sidebar-sections") as HTMLElement | null;

  /** Per-section expanded pixel height (only for expanded sections).
   *  This is the SINGLE source of truth — sash drag and toggle both write here,
   *  layoutSections() reads it. */
  const sectionSizes = new Map<string, number>();

  let activeSash: {
    sash: HTMLElement;
    aboveId: string;
    belowId: string;
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

  /** Get a stable ID for a section element. */
  function sectionId(el: HTMLElement): string {
    return el.id || el.dataset.sectionKey || "";
  }

  /**
   * Pixel layout engine — the SINGLE function that writes style.top and
   * style.height on every .section. Called after every state change (toggle,
   * sash drag, roots render, resize).
   *
   * Algorithm:
   * 1. Collapsed sections get HEADER_HEIGHT (28px).
   * 2. Remaining space is split among expanded sections proportionally
   *    to their sectionSizes entries (or equally if no entry exists).
   */
  function layoutSections(): void {
    if (!sidebarSections) return;
    const totalHeight = sidebarSections.clientHeight;
    const sections = getAllSections();
    if (sections.length === 0) return;

    // Separate expanded vs collapsed
    const expandedSections: HTMLElement[] = [];
    let collapsedHeight = 0;
    for (const s of sections) {
      if (s.classList.contains("expanded")) {
        expandedSections.push(s);
      } else {
        collapsedHeight += HEADER_HEIGHT;
      }
    }

    const availableForExpanded = Math.max(0, totalHeight - collapsedHeight);

    // Compute proportional heights for expanded sections
    let totalWeight = 0;
    for (const s of expandedSections) {
      totalWeight += sectionSizes.get(sectionId(s)) || 1;
    }

    const expandedHeights = new Map<HTMLElement, number>();
    if (expandedSections.length > 0 && totalWeight > 0) {
      let remaining = availableForExpanded;
      for (let i = 0; i < expandedSections.length; i++) {
        const s = expandedSections[i];
        const weight = sectionSizes.get(sectionId(s)) || 1;
        // Last expanded section gets the remainder to avoid rounding drift
        const h = i === expandedSections.length - 1
          ? remaining
          : Math.round(availableForExpanded * weight / totalWeight);
        expandedHeights.set(s, Math.max(HEADER_HEIGHT, h));
        remaining -= expandedHeights.get(s)!;
      }

      // Mop-up pass (VS Code "distributeEmptySpace" pattern):
      // Math.max(HEADER_HEIGHT, h) can inflate small sections without shrinking
      // others, causing total to overshoot availableForExpanded. Absorb the
      // overflow by trimming the largest sections (they have the most room above
      // HEADER_HEIGHT).
      let overflow = 0;
      for (const h of expandedHeights.values()) overflow += h;
      overflow -= availableForExpanded;
      if (overflow > 0) {
        // Sort expanded sections by height descending — shrink largest first
        const sorted = [...expandedHeights.entries()].sort((a, b) => b[1] - a[1]);
        for (const [s, h] of sorted) {
          if (overflow <= 0) break;
          const shrinkable = h - HEADER_HEIGHT;
          const take = Math.min(shrinkable, overflow);
          expandedHeights.set(s, h - take);
          overflow -= take;
        }
      }
    }

    // Write pixel positions — bottom-aligned (pixel equivalent of flex justify-content: flex-end).
    // Compute total used height first, then offset so sections sit at the bottom.
    let totalUsed = 0;
    for (const s of sections) {
      totalUsed += s.classList.contains("expanded")
        ? (expandedHeights.get(s) ?? HEADER_HEIGHT)
        : HEADER_HEIGHT;
    }
    let top = Math.max(0, totalHeight - totalUsed);
    for (const s of sections) {
      const h = s.classList.contains("expanded")
        ? (expandedHeights.get(s) ?? HEADER_HEIGHT)
        : HEADER_HEIGHT;
      s.style.top = top + "px";
      s.style.height = h + "px";
      top += h;
    }

    // Position sashes at section boundaries (between each pair of sections).
    const sashes = document.querySelectorAll(".sash");
    let sashIdx = 0;
    let boundary = Math.max(0, totalHeight - totalUsed);
    for (let i = 0; i < sections.length; i++) {
      const h = sections[i].classList.contains("expanded")
        ? (expandedHeights.get(sections[i]) ?? HEADER_HEIGHT)
        : HEADER_HEIGHT;
      boundary += h;
      if (i < sections.length - 1 && sashIdx < sashes.length) {
        (sashes[sashIdx] as HTMLElement).style.top = boundary + "px";
        sashIdx++;
      }
    }
  }

  /** Check if the user prefers reduced motion. */
  function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
          aboveId: sectionId(above),
          belowId: sectionId(below),
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

  // Global mousemove / mouseup for sash dragging
  document.addEventListener("mousemove", (e) => {
    if (!activeSash) return;
    const { above, below, aboveId, belowId, startY, startAboveH, startBelowH } = activeSash;
    const delta = e.clientY - startY;
    const total = startAboveH + startBelowH;
    const newAbove = Math.max(HEADER_HEIGHT, Math.min(startAboveH + delta, total - HEADER_HEIGHT));
    const newBelow = total - newAbove;
    // Write to sectionSizes — layoutSections reads these
    sectionSizes.set(aboveId, newAbove);
    sectionSizes.set(belowId, newBelow);
    // Instant pixel update — no .animated class during sash drag
    layoutSections();
  });

  document.addEventListener("mouseup", () => {
    if (!activeSash) return;
    activeSash.sash.classList.remove("active");
    document.body.classList.remove("sash-dragging");
    activeSash = null;
  });

  // Re-layout when the sidebar is resized (e.g. user drags the sidebar width)
  if (sidebarSections) {
    const ro = new ResizeObserver(() => layoutSections());
    ro.observe(sidebarSections);
  }

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

  /**
   * Animated expand/collapse for section bodies. VS Code PaneView pattern:
   * add .animated class to the container → let CSS transitions interpolate
   * the pixel top/height changes → remove .animated after transitionend.
   *
   * File tree .children toggling remains instant (display none/block).
   */
  const SECTION_ANIM_MS = 150;

  function toggleSectionBody(body: HTMLElement, expanding: boolean, section: HTMLElement): void {
    const id = sectionId(section);

    if (expanding) {
      body.style.display = "block";
      section.classList.add("expanded");
      body.classList.add("expanded");
    } else {
      section.classList.remove("expanded");
      body.classList.remove("expanded");
    }

    // Clear ALL cached sash-drag sizes so expanded sections split equally
    // after the topology change. Old pixel weights (e.g. 300 vs 1) would
    // starve the re-expanded section to header-only height.
    sectionSizes.clear();

    // Refresh sash active states
    document.querySelectorAll(".sash").forEach((s) => {
      (s as any)._setActive?.();
    });

    // Add .animated class for the transition (unless reduced motion)
    if (!prefersReducedMotion() && sidebarSections) {
      sidebarSections.classList.add("animated");
      layoutSections();

      const onEnd = () => {
        section.removeEventListener("transitionend", onEnd);
        sidebarSections!.classList.remove("animated");
        if (!expanding) {
          body.style.display = "none";
        }
      };
      section.addEventListener("transitionend", onEnd);

      // Safety timeout: remove .animated even if transitionend doesn't fire
      setTimeout(() => {
        sidebarSections!.classList.remove("animated");
        if (!expanding) {
          body.style.display = "none";
        }
      }, SECTION_ANIM_MS + 50);
    } else {
      // No animation — just layout and hide/show instantly
      layoutSections();
      if (!expanding) {
        body.style.display = "none";
      }
    }
  }

  function renderSectionHeader(title: string, sectionKey: string): { section: HTMLElement; body: HTMLElement } {
    const section = document.createElement("div");
    section.className = sectionExpanded[sectionKey] ? "section expanded" : "section";
    section.dataset.sectionKey = sectionKey;

    const header = document.createElement("div");
    header.className = "tree-section-label";

    const chevron = document.createElement("span");
    chevron.className = sectionExpanded[sectionKey] ? "section-chevron expanded" : "section-chevron";
    chevron.textContent = "\u203A"; // ›

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
    body.className = sectionExpanded[sectionKey] ? "section-body expanded" : "section-body";
    body.style.display = sectionExpanded[sectionKey] ? "block" : "none";

    section.appendChild(header);
    section.appendChild(body);

    header.addEventListener("click", () => {
      sectionExpanded[sectionKey] = !sectionExpanded[sectionKey];
      saveSectionState();
      chevron.classList.toggle("expanded", sectionExpanded[sectionKey]);
      toggleSectionBody(body, sectionExpanded[sectionKey], section);
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
    layoutSections();
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
    chevronEl.className = expanded[root.path] ? "chevron expanded" : "chevron";
    chevronEl.textContent = "\u203A"; // ›

    // Folder icon (omitted if theme has none — label sits next to chevron)
    const iconEl = createFolderIconEl(!!expanded[root.path]);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = root.name;

    row.appendChild(chevronEl);
    if (iconEl) row.appendChild(iconEl);
    row.appendChild(label);

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
      chevronEl.classList.toggle("expanded", expanded[root.path]);
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
    chevronEl.className = expanded[entry.path] ? "chevron expanded" : "chevron";
    chevronEl.textContent = "\u203A"; // ›

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

    // Drag-and-drop: directories are both draggable sources and drop targets.
    // Wire the row (header) and the outer container (covers the .children gap).
    setupDragSource(row, entry.path);
    setupDirectoryDropTarget(row, entry.path);
    setupDirectoryDropTarget(container, entry.path, row);

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
      chevronEl.classList.toggle("expanded", expanded[entry.path]);
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

    // Drag source + drop resolves to parent directory
    setupDragSource(row, entry.path);
    setupFileDropTarget(row);

    row.addEventListener("click", () => {
      vscode.postMessage({ kind: "open-file", path: entry.path });
    });

    return row;
  }

  // ── Drag-and-drop helpers ─────────────────────────────────────────────────

  function setupDragSource(el: HTMLElement, sourcePath: string): void {
    let dragImage: HTMLElement | null = null;

    el.addEventListener("dragstart", (e) => {
      dragSourcePath = sourcePath;
      el.classList.add("dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", sourcePath);

      // Create a floating pill (VS Code explorer-style drag image)
      dragImage = document.createElement("div");
      dragImage.className = "drag-image";

      // Clone the icon if present
      const iconSrc = el.querySelector(".icon") as HTMLElement | null;
      if (iconSrc) {
        dragImage.appendChild(iconSrc.cloneNode(true));
      }

      // Clone the label
      const labelSrc = el.querySelector(".label") as HTMLElement | null;
      if (labelSrc) {
        const labelClone = labelSrc.cloneNode(true) as HTMLElement;
        // Strip git-status classes so the pill uses neutral text
        labelClone.className = "label";
        dragImage.appendChild(labelClone);
      }

      // Position off-screen so it's invisible in the DOM but renderable for setDragImage
      dragImage.style.position = "absolute";
      dragImage.style.top = "-1000px";
      dragImage.style.left = "-1000px";
      document.body.appendChild(dragImage);
      e.dataTransfer!.setDragImage(dragImage, 16, 12);
    });

    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      dragSourcePath = null;
      clearDropTarget();
      if (dragImage) {
        dragImage.remove();
        dragImage = null;
      }
    });
  }

  function setupDirectoryDropTarget(el: HTMLElement, targetDir: string, highlightEl?: HTMLElement): void {
    const highlight = highlightEl ?? el;
    el.addEventListener("dragover", (e) => {
      if (!dragSourcePath) return;
      // Don't allow dropping on self or on a parent of the source
      if (dragSourcePath === targetDir) return;
      if (dragSourcePath.startsWith(targetDir + "/")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (currentDropTarget !== highlight) {
        clearDropTarget();
        currentDropTarget = highlight;
        highlight.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", (e) => {
      // Only clear if we're really leaving (not entering a child)
      const related = e.relatedTarget as HTMLElement | null;
      if (related && el.contains(related)) return;
      if (currentDropTarget === highlight) {
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

  /** Resolve the nearest directory ancestor from a file row and wire it as a drop target. */
  function setupFileDropTarget(el: HTMLElement): void {
    el.addEventListener("dragover", (e) => {
      if (!dragSourcePath) return;
      const dirContainer = el.closest("[data-type=\"directory\"]") as HTMLElement | null;
      if (!dirContainer) return;
      const dirPath = dirContainer.dataset.path!;
      if (dragSourcePath === dirPath) return;
      if (dragSourcePath.startsWith(dirPath + "/")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      const dirRow = dirContainer.querySelector(":scope > .tree-node") as HTMLElement | null;
      if (!dirRow) return;
      if (currentDropTarget !== dirRow) {
        clearDropTarget();
        currentDropTarget = dirRow;
        dirRow.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (related && el.contains(related)) return;
      // Only clear if nothing else has claimed the target
      const dirContainer = el.closest("[data-type=\"directory\"]") as HTMLElement | null;
      const dirRow = dirContainer?.querySelector(":scope > .tree-node") as HTMLElement | null;
      if (currentDropTarget === dirRow) {
        clearDropTarget();
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropTarget();
      const sourcePath = e.dataTransfer?.getData("text/plain");
      const dirContainer = el.closest("[data-type=\"directory\"]") as HTMLElement | null;
      const targetDir = dirContainer?.dataset.path;
      if (!sourcePath || !targetDir || sourcePath === targetDir) return;
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
          // Guard the inline edit temp row: innerHTML="" will detach the
          // focused input, firing blur synchronously — suppress cancel.
          const hasInlineEdit = activeInlineEdit?.tempRow && activeInlineEdit.path === msg.path;
          if (hasInlineEdit) inlineEditRerendering = true;
          renderChildren(container as HTMLElement, msg.entries ?? [], depth);
          inlineEditRerendering = false;
          // Re-insert the inline edit temp row after children are rendered
          if (hasInlineEdit && activeInlineEdit?.tempRow) {
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
        if (chevronSpan) chevronSpan.classList.add("expanded");
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

  // Position the fleet section immediately (roots arrive async via get-roots)
  layoutSections();
  vscode.postMessage({ kind: "get-roots" });
})();
