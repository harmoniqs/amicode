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
}

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

  // ── Tree rendering ─────────────────────────────────────────────────────────

  let currentRoots: TreeRoot[] = [];
  // Cache children per directory path
  const childrenCache: Record<string, TreeEntry[]> = {};

  function renderRoots(roots: TreeRoot[]): void {
    if (!treeRoot) return;
    currentRoots = roots;
    treeRoot.innerHTML = "";

    // Group: research first, then dev
    const research = roots.filter((r) => r.projectType === "research");
    const dev = roots.filter((r) => r.projectType === "dev");

    if (research.length > 0) {
      const label = document.createElement("div");
      label.className = "tree-section-label";
      label.textContent = "Research Projects";
      treeRoot.appendChild(label);
      for (const root of research) {
        treeRoot.appendChild(renderRootNode(root, 0));
      }
    }

    if (dev.length > 0) {
      const label = document.createElement("div");
      label.className = "tree-section-label";
      label.textContent = "Development";
      treeRoot.appendChild(label);
      for (const root of dev) {
        treeRoot.appendChild(renderRootNode(root, 0));
      }
    }
  }

  function renderRootNode(root: TreeRoot, depth: number): HTMLElement {
    const container = document.createElement("div");
    container.dataset.path = root.path;
    container.dataset.type = "directory";

    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.paddingLeft = `${8 + depth * 16}px`;

    // Chevron
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = expanded[root.path] ? "\u25BE" : "\u25B8"; // ▾ / ▸

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = root.name;

    row.appendChild(icon);
    row.appendChild(label);

    // Research metadata pill
    if (root.projectType === "research" && root.metadata?.phase) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = root.metadata.phase;
      row.appendChild(pill);
    }

    container.appendChild(row);

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
      icon.textContent = expanded[root.path] ? "\u25BE" : "\u25B8";
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

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = expanded[entry.path] ? "\u25BE" : "\u25B8";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;

    row.appendChild(icon);
    row.appendChild(label);
    container.appendChild(row);

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
      icon.textContent = expanded[entry.path] ? "\u25BE" : "\u25B8";
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

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "\u{1F4C4}"; // 📄

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.name;

    row.appendChild(icon);
    row.appendChild(label);

    row.addEventListener("click", () => {
      vscode.postMessage({ kind: "open-file", path: entry.path });
    });

    return row;
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
    }
  });

  // ── Initial load ───────────────────────────────────────────────────────────

  vscode.postMessage({ kind: "get-roots" });
})();
