// ============================================================================
// Chat Deck shell — runs INSIDE the deck webview (dist/deck_shell.js). A tiny
// window manager for chat panes: groups of iframed apps in a horizontal row,
// VS Code-style drag physics (drag a tab onto a strip to move it, onto a
// group's edge to split, and a group that empties merges back), draggable
// sashes, live labels via the fork's route-info bridge.
//
// DOM discipline that makes this work at all:
//  - iframes RELOAD when reparented, so nothing ever reparents one: group
//    order is set via CSS `order`, inactive tabs are display:none, and only
//    the DRAGGED tab pays the one unavoidable reload (its iframe is rebuilt at
//    its current route — sessions restore from the server; draft composer
//    text survives via the app's persisted draft store keyed by draftId).
//  - during drags, iframes take pointer-events:none so dragover/pointermove
//    reach shell elements (they'd otherwise be swallowed cross-frame).
// Security: labels render via textContent only; adopted routes must be
// same-origin paths ("/..."), never absolute URLs; the boot credential lives
// only in JS memory and is re-minted onto frame srcs at build time — it is
// NEVER written to webview state (secrets don't go to disk).
// ============================================================================

import {
  createDeck,
  addTab,
  closeTab,
  activateTab,
  moveTab,
  splitTab,
  setTabLabel,
  resizeGroups,
  type Deck,
  type DeckGroup,
  type DeckTab,
} from "./model";

interface DeckBoot {
  origin: string;
  authToken?: string;
  colorScheme: "light" | "dark";
  hideProjectDir?: string;
}

declare const acquireVsCodeApi: <T>() => { postMessage(m: unknown): void; setState(s: unknown): void; getState(): T | undefined };

const boot = (window as unknown as { __AMICODE_DECK__: DeckBoot }).__AMICODE_DECK__;
const vscode = acquireVsCodeApi<{ deck: Deck }>();

const uid = (): string =>
  (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const draftTab = (): DeckTab => ({ id: uid(), url: `/new-session?draftId=${uid()}`, label: "New session", kind: "draft" });

/** path-only tab.url → full frame src with boot params re-minted on. */
function frameSrc(tab: DeckTab): string {
  const u = new URL(tab.url, boot.origin);
  u.searchParams.set("colorScheme", boot.colorScheme);
  if (boot.authToken) u.searchParams.set("auth_token", boot.authToken);
  if (boot.hideProjectDir) u.searchParams.set("amicode_hide_project", boot.hideProjectDir);
  return u.href;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const restored = vscode.getState();
let deck: Deck = restored?.deck && restored.deck.groups.length > 0 ? restored.deck : addTab(createDeck(), uid(), draftTab());

const groupEls = new Map<string, HTMLElement>(); // groupId → group element
const frameByTab = new Map<string, HTMLIFrameElement>(); // tabId → live iframe
let drag: { tabId: string; srcGroupId: string } | null = null;

const persist = () => vscode.setState({ deck });

// ---------------------------------------------------------------------------
// Styles (constructable — not CSP-governed)
// ---------------------------------------------------------------------------

const css = `
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  body { font: 12px var(--vscode-font-family, sans-serif); }
  #deck { display: flex; height: 100vh; width: 100vw; }
  .group { display: flex; flex-direction: column; min-width: 140px; min-height: 0; }
  .strip {
    display: flex; align-items: stretch; height: 34px; flex: none; overflow-x: auto; overflow-y: hidden;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-editorGroupHeader-border, var(--vscode-panel-border, transparent));
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar { display: none; }
  .tab {
    display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; max-width: 180px; flex: none;
    color: var(--vscode-tab-inactiveForeground, #888); cursor: pointer; user-select: none; white-space: nowrap;
    border-right: 1px solid var(--vscode-tab-border, transparent);
  }
  .tab.active {
    color: var(--vscode-tab-activeForeground, #fff);
    background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
    box-shadow: inset 0 1px 0 var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder, transparent));
  }
  .tab .lbl { overflow: hidden; text-overflow: ellipsis; }
  .tab.dragging { opacity: 0.45; }
  .tab .x {
    visibility: hidden; border: 0; background: none; color: inherit; cursor: pointer; padding: 1px 3px;
    border-radius: 4px; font-size: 12px; line-height: 1;
  }
  .tab:hover .x, .tab.active .x { visibility: visible; }
  .tab .x:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.3)); }
  .ghostbtn {
    border: 0; background: none; cursor: pointer; flex: none; align-self: center; margin: 0 4px; padding: 2px 6px;
    color: var(--vscode-tab-inactiveForeground, #888); border-radius: 4px; font-size: 14px; line-height: 1;
  }
  .ghostbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.3)); }
  .frames { position: relative; flex: 1; min-height: 0; }
  .frames iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  .frames iframe.hidden { display: none; }
  body.dragging .frames iframe, body.sashing .frames iframe { pointer-events: none !important; }
  .drop-hl {
    position: absolute; top: 0; bottom: 0; z-index: 30; pointer-events: none; display: none;
    background: var(--vscode-editorGroup-dropBackground, rgba(0, 122, 204, 0.25));
  }
  body.dragging .drop-hl.on { display: block; }
  .sash { width: 4px; flex: none; cursor: col-resize; z-index: 40; }
  .sash:hover, body.sashing .sash.live { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder, #007acc)); }
  #empty {
    display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center;
    height: 100vh; width: 100vw; color: var(--vscode-descriptionForeground, #888);
  }
  #empty button {
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 6px 14px; cursor: pointer;
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
  }
`;
const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const root = document.createElement("div");
root.id = "deck";
document.body.appendChild(root);

function syncStrip(group: DeckGroup, stripEl: HTMLElement): void {
  stripEl.textContent = "";
  for (const t of group.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === group.activeTabId ? " active" : "");
    el.draggable = true;
    el.dataset.tabId = t.id;
    el.title = t.label;
    if (drag?.tabId === t.id) el.classList.add("dragging");
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = t.label; // untrusted (route-info) — textContent only
    el.appendChild(lbl);
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      apply(closeTab(deck, group.id, t.id));
    });
    el.appendChild(x);
    el.addEventListener("click", () => apply(activateTab(deck, group.id, t.id)));
    el.addEventListener("dragstart", (e) => {
      drag = { tabId: t.id, srcGroupId: group.id };
      e.dataTransfer?.setData("text/plain", t.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      document.body.classList.add("dragging");
      requestAnimationFrame(() => el.classList.add("dragging"));
    });
    el.addEventListener("dragend", () => endDrag());
    stripEl.appendChild(el);
  }
  const plus = document.createElement("button");
  plus.className = "ghostbtn";
  plus.textContent = "+";
  plus.title = "New chat in this pane";
  plus.addEventListener("click", () => apply(addTab(deck, group.id, draftTab())));
  stripEl.appendChild(plus);
}

function syncFrames(group: DeckGroup, framesEl: HTMLElement): void {
  const want = new Set(group.tabs.map((t) => t.id));
  // Drop iframes whose tab left this group (the dragged tab's old frame is
  // discarded here; its replacement was built by the destination's sync).
  for (const el of Array.from(framesEl.querySelectorAll("iframe"))) {
    const id = (el as HTMLIFrameElement).dataset.tabId ?? "";
    if (!want.has(id)) {
      frameByTab.delete(id);
      el.remove();
    }
  }
  for (const t of group.tabs) {
    let f = frameByTab.get(t.id);
    if (!f || f.dataset.tabUrl !== t.url) {
      // New tab, or the tab's route advanced while its old frame was gone —
      // build at the CURRENT route (the one reload we can't avoid on a move).
      f?.remove();
      f = document.createElement("iframe");
      f.dataset.tabId = t.id;
      f.dataset.tabUrl = t.url;
      f.src = frameSrc(t);
      f.setAttribute("allow", "clipboard-read; clipboard-write");
      f.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-downloads");
      frameByTab.set(t.id, f);
      framesEl.appendChild(f);
    }
    f.classList.toggle("hidden", t.id !== group.activeTabId);
  }
}

function render(): void {
  const seen = new Set<string>();
  deck.groups.forEach((group, i) => {
    seen.add(group.id);
    let gEl = groupEls.get(group.id);
    if (!gEl) {
      gEl = document.createElement("section");
      gEl.className = "group";
      const strip = document.createElement("div");
      strip.className = "strip";
      const frames = document.createElement("div");
      frames.className = "frames";
      for (const side of ["left", "right"] as const) {
        const hl = document.createElement("div");
        hl.className = "drop-hl";
        hl.dataset.side = side;
        hl.style[side] = "0";
        hl.style.width = "50%";
        gEl.appendChild(hl);
      }
      gEl.appendChild(strip);
      gEl.appendChild(frames);
      gEl.dataset.groupId = group.id;
      wireDropTargets(gEl, group.id);
      groupEls.set(group.id, gEl);
      root.appendChild(gEl); // appended once — NEVER reparented (order via CSS)
      // sash after this group (except the last)
      const sash = document.createElement("div");
      sash.className = "sash";
      sash.dataset.afterGroupId = group.id;
      root.appendChild(sash);
      wireSash(sash);
    }
    gEl.style.order = String(i * 2); // groups interleave with sashes
    gEl.style.flex = `${group.flex} 1 0`;
    syncStrip(group, gEl.querySelector(".strip") as HTMLElement);
    syncFrames(group, gEl.querySelector(".frames") as HTMLElement);
  });
  // remove vanished groups + retune sashes
  for (const [id, el] of Array.from(groupEls)) {
    if (!seen.has(id)) {
      groupEls.delete(id);
      el.remove();
    }
  }
  let sashIdx = 0;
  for (const sash of Array.from(root.querySelectorAll(".sash"))) {
    const el = sash as HTMLElement;
    if (sashIdx < deck.groups.length - 1) {
      el.style.display = "";
      el.style.order = String(sashIdx * 2 + 1);
      el.dataset.afterGroupId = deck.groups[sashIdx].id;
      sashIdx++;
    } else {
      el.remove();
    }
  }
  persist();
}

function apply(next: Deck): void {
  if (next === deck) return;
  // The deck never sits empty: closing the last tab of the last group spawns
  // a fresh draft — it's a chat tool, not an editor area.
  if (next.groups.length === 0) next = addTab(next, uid(), draftTab());
  deck = next;
  render();
}

// ---------------------------------------------------------------------------
// Drag & drop physics
// ---------------------------------------------------------------------------

function endDrag(): void {
  drag = null;
  document.body.classList.remove("dragging");
  for (const hl of Array.from(document.querySelectorAll(".drop-hl"))) hl.classList.remove("on");
}

function wireDropTargets(gEl: HTMLElement, groupId: string): void {
  gEl.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = gEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const overStrip = (e.target as HTMLElement).closest(".strip") !== null;
    for (const hl of Array.from(gEl.querySelectorAll(".drop-hl"))) {
      const side = (hl as HTMLElement).dataset.side;
      const on = !overStrip && (side === "left" ? x < rect.width * 0.3 : x > rect.width * 0.7);
      hl.classList.toggle("on", on);
    }
  });
  gEl.addEventListener("drop", (e) => {
    if (!drag) return;
    e.preventDefault();
    const { tabId, srcGroupId } = drag;
    const target = e.target as HTMLElement;
    const rect = gEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const stripEl = target.closest(".strip") as HTMLElement | null;
    if (stripEl) {
      // Insert at the tab midpoint the pointer is over (append at the end).
      const tabs = Array.from(stripEl.querySelectorAll(".tab")) as HTMLElement[];
      let idx = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          idx = i;
          break;
        }
      }
      // Final-array indexing: removing the dragged tab shifts later indices.
      const srcGroup = deck.groups.find((g) => g.id === srcGroupId);
      if (srcGroupId === groupId && srcGroup) {
        const from = srcGroup.tabs.findIndex((t) => t.id === tabId);
        if (from !== -1 && from < idx) idx -= 1;
      }
      apply(moveTab(deck, srcGroupId, tabId, groupId, idx));
    } else if (x < rect.width * 0.3 || x > rect.width * 0.7) {
      apply(splitTab(deck, srcGroupId, tabId, groupId, x < rect.width * 0.3 ? "left" : "right", uid()));
    } else {
      const dst = deck.groups.find((g) => g.id === groupId);
      apply(moveTab(deck, srcGroupId, tabId, groupId, dst ? dst.tabs.length : 0));
    }
    endDrag();
  });
}

// ---------------------------------------------------------------------------
// Sashes
// ---------------------------------------------------------------------------

function wireSash(sash: HTMLElement): void {
  sash.addEventListener("pointerdown", (e) => {
    const afterId = sash.dataset.afterGroupId;
    const gi = deck.groups.findIndex((g) => g.id === afterId);
    if (gi === -1 || gi + 1 >= deck.groups.length) return;
    const l = deck.groups[gi];
    const r = deck.groups[gi + 1];
    const lEl = groupEls.get(l.id);
    const rEl = groupEls.get(r.id);
    if (!lEl || !rEl) return;
    sash.setPointerCapture(e.pointerId);
    sash.classList.add("live");
    document.body.classList.add("sashing");
    const startX = e.clientX;
    const sum = l.flex + r.flex;
    const pxSum = lEl.getBoundingClientRect().width + rEl.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dFlex = (dx / Math.max(pxSum, 1)) * sum;
      const nl = Math.max(0.3, Math.min(sum - 0.3, l.flex + dFlex));
      apply(resizeGroups(deck, l.id, r.id, nl, sum - nl));
    };
    const onUp = () => {
      sash.classList.remove("live");
      document.body.classList.remove("sashing");
      sash.removeEventListener("pointermove", onMove);
      sash.removeEventListener("pointerup", onUp);
    };
    sash.addEventListener("pointermove", onMove);
    sash.addEventListener("pointerup", onUp);
  });
}

// ---------------------------------------------------------------------------
// Bridges: iframe ⇄ shell ⇄ extension
// ---------------------------------------------------------------------------

const tabBySource = (source: MessageEventSource | null): string | undefined => {
  for (const [id, f] of frameByTab) {
    if (f.contentWindow === source) return id;
  }
  return undefined;
};

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "amicode") return;

  // Lane 1 — extension → shell (webview-internal origin, never the app origin):
  // theme fan-out, clipboard replies, inspector fan-out, dev-tools replies.
  if (e.origin !== boot.origin) {
    if (d.kind === "theme" && (d.colorScheme === "light" || d.colorScheme === "dark")) {
      boot.colorScheme = d.colorScheme;
      for (const f of frameByTab.values()) f.contentWindow?.postMessage({ source: "amicode", kind: "theme", colorScheme: d.colorScheme }, boot.origin);
    }
    if (d.kind === "clipboard" && typeof d.tab === "string") {
      frameByTab.get(d.tab)?.contentWindow?.postMessage(d, boot.origin);
    }
    if ((d.kind === "dev-tools-status" || d.kind === "dev-tools-rebuild-status") && typeof d.tab === "string") {
      frameByTab.get(d.tab)?.contentWindow?.postMessage(d, boot.origin);
    }
    // #351: inspector fan-out — broadcast to every live pane (no tab routing;
    // the app's Work Column tabs buffer per-run/per-device themselves).
    if (typeof d.kind === "string" && (d.kind.indexOf("run:") === 0 || d.kind.indexOf("device:") === 0)) {
      for (const f of frameByTab.values()) f.contentWindow?.postMessage(d, boot.origin);
    }
    return;
  }

  // Lane 2 — app iframes → shell (origin-checked against the server origin).
  const tabId = tabBySource(e.source);

  // route-info (fork bridge): live label + current route for future rebuilds.
  // Adopt paths only — never absolute URLs (an injected message must not be
  // able to point a pane at an arbitrary origin).
  if (d.kind === "route-info" && typeof d.path === "string" && tabId) {
    const safe = d.path.startsWith("/") && !d.path.startsWith("//") ? d.path : undefined;
    let changed = false;
    if (safe) {
      for (const g of deck.groups) {
        const t = g.tabs.find((t) => t.id === tabId);
        if (t && t.url !== safe) {
          t.url = safe; // path only — frameSrc re-mints params; mutation OK here (no re-render needed)
          // The iframe navigated ITSELF to this route — mark it in sync so the
          // next render doesn't pointlessly rebuild it.
          const f = frameByTab.get(tabId);
          if (f) f.dataset.tabUrl = safe;
          changed = true;
        }
      }
    }
    if (typeof d.title === "string" && d.title.length > 0) {
      apply(setTabLabel(deck, tabId, d.title.slice(0, 120)));
      return;
    }
    if (changed) persist();
    return;
  }

  // clipboard-image-request is answered shell-side (the shell webview has
  // clipboard-read; the sandboxed iframe doesn't) — reply to the ASKING pane.
  if (d.kind === "clipboard-image-request") {
    void (async () => {
      const payload = { source: "amicode", kind: "clipboard-image", nonce: d.nonce, dataUrl: null as string | null, mime: null as string | null, filename: null as string | null };
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (!type) continue;
          const blob = await item.getType(type);
          payload.dataUrl = await new Promise<string | null>((res) => {
            const r = new FileReader();
            r.onload = () => res(typeof r.result === "string" ? r.result : null);
            r.onerror = () => res(null);
            r.readAsDataURL(blob);
          });
          if (payload.dataUrl) {
            payload.mime = type;
            payload.filename = `pasted-image.${type.split("/")[1] ?? "png"}`;
          }
          break;
        }
      } catch {
        /* dataUrl:null → app falls back to text paste */
      }
      (e.source as Window | null)?.postMessage(payload, boot.origin);
    })();
    return;
  }

  // Everything else rides up to the extension, tagged with the asking pane so
  // replies (clipboard text) route back correctly.
  if (d.kind === "command" || d.kind === "clipboard-request" || d.kind === "clipboard-write" || d.kind === "open-external" || d.kind === "open-file" || d.kind === "save-file" || d.kind === "set-default-model" || d.kind === "dev-tools-update" || d.kind === "dev-tools-rebuild" || d.kind === "device:refresh") {
    vscode.postMessage({ ...d, tab: tabId });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (deck.groups.length === 0) deck = addTab(deck, uid(), draftTab());
render();
