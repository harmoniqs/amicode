// ============================================================================
// dist build id (#1556, subsuming #1459's stamping half) — the primitives of
// the live-test reload lane. The fleet's post-deploy ceremony is "the agent
// ships the dist, the developer reloads the window"; it broke twice because
// (a) VS Code's webview service worker caches the panel iframe's NAVIGATION,
// so the freshly shipped index never reaches the frame until the outer
// webview's cache is cleared by hand (#1459's diagnosis), and (b) nothing
// ever told the developer a new build was live — the agent's last message had
// to do the UI's job. Both halves are tractable from the extension HOST alone
// because the host's fetches bypass the webview SW entirely: a GET of the
// panel origin's document always sees the true current dist, even while the
// framed app is stuck on the previous ship.
//
// The version is already mechanically present: every vite build mints the
// entry asset as index-<contentHash>.js, so the origin doc's entry reference
// IS the served build id (a clean /amicode/app-version route is a named
// follow-up, not this slice). Fail-soft throughout: an unparseable doc, a
// failed fetch, a non-200 — all degrade to undefined, never a throw, never an
// error surface. vscode-free on purpose: every seam is injectable so the
// unit tests need neither the VS Code API nor the network.
// ============================================================================

/** The slow poll cadence for the new-build prompt (#1556): one small GET every
 *  3 minutes while a chat panel is alive. Cheap enough to leave running, slow
 *  enough that it is never a nag loop; the once-per-version semantics below
 *  guarantee at most ONE prompt per shipped version regardless of cadence. */
export const BUILD_CHANGE_POLL_INTERVAL_MS = 3 * 60 * 1000;

/** The cap on the panel-construction served-id fetch: the origin doc is a
 *  local/tunnel hop away (milliseconds), but a hung tunnel must never wedge a
 *  derivation — it resolves undefined at 3s and the lane degrades honestly. */
export const SERVED_BUILD_ID_FETCH_TIMEOUT_MS = 3_000;

/** The prompt's action button — clicking it reloads the window. */
export const RELOAD_WINDOW_BUTTON = "Reload Window";

/** Extract the build id from a served dist's index.html: the content hash in
 *  its `index-<hash>.js` entry-asset reference (e.g. `/assets/index-C8RDSfBx.js`
 *  → "C8RDSfBx"; the stylesheet's different hash is NOT the id). The hash
 *  charset is vite/rollup's base64url — letters, digits, `_`, `-`. The match
 *  requires `index-` to start a fresh filename token (a preceding path
 *  separator, quote, or whitespace) so a differently-named asset like
 *  `my-index-abc.js` is never mistaken for the entry. First reference wins.
 *  undefined on no-match or empty input — an unparseable origin doc never
 *  breaks anything upstream. */
export function distBuildIdFromIndexHtml(html: string): string | undefined {
  if (!html) return undefined;
  const m = html.match(/(?:^|[^A-Za-z0-9_.-])index-([A-Za-z0-9_-]+)\.js\b/);
  return m?.[1];
}

/** GET the origin document and derive the served build id from it. NEVER
 *  throws: fetch failure, abort, non-200, unparseable body, malformed origin —
 *  all resolve undefined (the honest "this origin's version is unknown").
 *  `fetchImpl` is the injection seam for tests; production uses the host's
 *  global fetch, whose requests bypass the webview SW (#1556's whole premise).
 *  The target is the ORIGIN document ("/") — the same doc the panel's iframe
 *  navigates — regardless of any deeper path on the input. */
export async function fetchServedBuildId(
  origin: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  try {
    let url: URL;
    try {
      url = new URL("/", origin);
    } catch {
      return undefined;
    }
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(url.toString(), { signal, headers: { accept: "text/html" } });
    if (res.status !== 200) return undefined;
    return distBuildIdFromIndexHtml(await res.text());
  } catch {
    return undefined;
  }
}

/** setInterval/clearInterval seam — the production watcher uses the host's
 *  real timers; tests inject a manual clock so a 3-minute poll is one tick. */
export interface BuildChangeClock {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BuildChangeWatcherDeps {
  /** The origin the panel's iframe is currently framed at (a re-frame to the
   *  service shelf switches it mid-life; the poll follows whatever is live). */
  origin(): string;
  /** The build id the loaded panel was STAMPED with; undefined when the
   *  construction-time derivation failed (unstamped — an unknown baseline). */
  stampedBuildId(): string | undefined;
  /** The served-id fetch — the same derivation seam (fetchServedBuildId). */
  fetchServed(origin: string): Promise<string | undefined>;
  /** Show the information message; returns the chosen item label, or
   *  undefined on decline/dismiss. Injected so tests need no VS Code API;
   *  production wires vscode.window.showInformationMessage. */
  prompt(message: string, ...items: string[]): PromiseLike<string | undefined>;
  /** What runs when the user picks the Reload Window button (production:
   *  workbench.action.reloadWindow via vscode.commands.executeCommand). */
  reload(): void;
  /** The already-prompted version ids. Share ONE set across a window's
   *  watchers so a ship prompts exactly once no matter how many chat tabs
   *  are live (#1556's "exactly one prompt" AC); default = a private set
   *  (unit tests get isolated semantics). */
  prompted?: Set<string>;
  /** Clock injection (tests); default = the host's real timers. */
  clock?: BuildChangeClock;
  /** Poll cadence override (tests); default BUILD_CHANGE_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
}

/** The new-build prompt (#1556's ceremony half): while a panel is alive, poll
 *  the served build id on the slow interval and compare it to the id the
 *  panel was stamped with. When they differ, show ONE information message —
 *  "Amicode: a new app build is live (<id>). Reload Window to pick it up." —
 *  with a Reload Window button. Once-per-version semantics: a version is
 *  marked prompted BEFORE the prompt resolves (accept, decline, and dismiss
 *  all count), so the same served id never re-prompts; a NEWER id later
 *  prompts again. Share one `prompted` set across a window's watchers and a
 *  ship prompts EXACTLY once no matter how many chat tabs are live. A served
 *  id of undefined (fetch failed) never prompts and never compares.
 *  Disposable: the owning panel clears the interval with its own lifecycle. */
export class BuildChangeWatcher {
  private readonly clock: BuildChangeClock;
  private readonly handle: unknown;
  private readonly prompted: Set<string>;
  private busy = false;
  private disposed = false;

  constructor(private readonly deps: BuildChangeWatcherDeps) {
    this.prompted = deps.prompted ?? new Set<string>();
    this.clock =
      deps.clock ?? {
        setInterval: (cb, ms) => setInterval(cb, ms),
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      };
    this.handle = this.clock.setInterval(
      () => void this.poll(),
      deps.pollIntervalMs ?? BUILD_CHANGE_POLL_INTERVAL_MS,
    );
  }

  /** One poll tick — public so the interval callback and the tests share the
   *  exact same path. Re-entrant calls are ignored (a slow fetch can't stack
   *  a second prompt on top of a pending one). */
  async poll(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      const served = await this.deps.fetchServed(this.deps.origin());
      if (served === undefined) return; // fetch failed — never prompt, never compare
      if (served === this.deps.stampedBuildId()) return; // panel is current
      if (this.prompted.has(served)) return; // once per version — no nag loop
      this.prompted.add(served);
      const choice = await this.deps.prompt(
        `Amicode: a new app build is live (${served}). Reload Window to pick it up.`,
        RELOAD_WINDOW_BUTTON,
      );
      if (choice === RELOAD_WINDOW_BUTTON) this.deps.reload();
    } catch {
      /* fail-soft: the prompt lane must never disturb the panel */
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clock.clearInterval(this.handle);
  }
}
