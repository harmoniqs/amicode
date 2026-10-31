// sidebar_reveal.ts — the pure planning behind "Find in sidebar" (#1036).
//
// The sidebar webview is raw imperative DOM and its children arrive
// asynchronously (`get-children` / `children` round-trips through the host), so
// the reveal is a small sequential state machine: open the first collapsed
// ancestor, wait for its children to render, repeat, then scroll + flash. These
// helpers decide each step without touching the DOM, so they are unit-testable;
// sidebar_webview.ts (a browser IIFE) imports them and does the DOM work.

/** The file lands this many rows below the visible top of the tree. */
export const REVEAL_CONTEXT_ROWS = 3;
/** How long the row highlight stays before it fades out. */
export const REVEAL_HIGHLIGHT_MS = 2500;
/** Give up on an awaited children load after this long (no broken state). */
export const REVEAL_LOAD_TIMEOUT_MS = 5000;

const trimTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** The folders that must be open, top-down, for `filePath` to be visible: its
 *  owning root first, then every intermediate directory (the file itself is
 *  excluded). Undefined — a silent no-op — when the path is empty, relative, or
 *  outside every root. Segment-aware (`/w/proj-two` is not under `/w/proj`) and
 *  the deepest owning root wins. */
export function revealChain(filePath: string, rootPaths: readonly string[]): { root: string; dirs: string[] } | undefined {
  if (!filePath || !filePath.startsWith("/")) return undefined;
  let owner: { raw: string; norm: string } | undefined;
  for (const raw of rootPaths) {
    const norm = trimTrailingSlash(raw);
    if (!(filePath === norm || filePath.startsWith(norm === "/" ? "/" : norm + "/"))) continue;
    if (filePath === norm) continue; // the root itself has no file inside it to reveal
    if (!owner || norm.length > owner.norm.length) owner = { raw, norm };
  }
  if (!owner) return undefined;
  const dirs = [owner.raw];
  const relative = filePath.slice(owner.norm === "/" ? 1 : owner.norm.length + 1).split("/");
  let current = owner.norm === "/" ? "" : owner.norm;
  for (const segment of relative.slice(0, -1)) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return { root: owner.raw, dirs };
}

export type RevealAction =
  | { kind: "expand"; path: string } // a collapsed ancestor: open it, then plan again
  | { kind: "load"; path: string } // open but its children are not cached: request + wait
  | { kind: "scroll" } // every ancestor open and the target row exists
  | { kind: "none" }; // target never appeared: silent no-op

/** The next step of a reveal. Strictly top-down — a child's DOM only exists once
 *  its parent's children rendered, so expanding in parallel would race. */
export function nextRevealAction(input: {
  dirs: readonly string[];
  expanded: (path: string) => boolean;
  childrenLoaded: (path: string) => boolean;
  targetInDom: boolean;
}): RevealAction {
  for (const path of input.dirs) {
    if (!input.expanded(path)) return { kind: "expand", path };
    if (!input.childrenLoaded(path)) return { kind: "load", path };
  }
  return input.targetInDom ? { kind: "scroll" } : { kind: "none" };
}

/** scrollTop that puts a row `REVEAL_CONTEXT_ROWS` rows below the visible top. */
export const revealScrollTop = (targetTop: number, rowHeight: number): number =>
  Math.max(0, targetTop - REVEAL_CONTEXT_ROWS * rowHeight);
