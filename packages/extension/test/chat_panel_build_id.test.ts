import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { ChatPanel } from "../src/chat_panel";
import { mintServerPassword, serverAuthToken } from "../src/server_auth";
import { BUILD_CHANGE_POLL_INTERVAL_MS, RELOAD_WINDOW_BUTTON, type BuildChangeClock } from "../src/dist_build_id";

// ============================================================================
// #1556 (subsuming #1459) — the stamp half of the live-test reload lane at
// the ChatPanel. The panel's iframe src gains `amicode_build=<id>` (the served
// dist's content hash, derived host-side from the origin doc) on BOTH HTML
// paths, so every ship mints a document URL the webview's service worker has
// never cached — Reload Window lands the fresh build with no cache surgery
// (#1459). The auth_token (#163) and every existing boot param must survive
// the stamp untouched; a failed/unparseable derivation leaves the src exactly
// as today (honest degradation). While the panel is alive, the watcher half
// polls the served id and prompts once per version when it drifts from the
// stamp, with a Reload Window button that runs the reload command.
// ============================================================================

type CapturedPanel = { webview: { html: string }; dispose(): void };

/** Wrap the mock's createWebviewPanel to capture the panel openOrReveal builds
 *  (chat_panel.test.ts's harness idiom — the html is the surface under test). */
function capturePanel(): { created: CapturedPanel[]; restore: () => void } {
  const created: CapturedPanel[] = [];
  const w = vscode.window as unknown as { createWebviewPanel: (...a: unknown[]) => CapturedPanel };
  const orig = w.createWebviewPanel;
  w.createWebviewPanel = (...a: unknown[]) => {
    const p = orig(...a);
    created.push(p);
    return p;
  };
  return { created, restore: () => (w.createWebviewPanel = orig) };
}

function fakeCtx(): vscode.ExtensionContext {
  return { extensionUri: { fsPath: "/ext" } } as unknown as vscode.ExtensionContext;
}

const iframeSrc = (html: string): URL => {
  const m = html.match(/<iframe src="([^"]+)"/);
  expect(m).toBeTruthy();
  return new URL(m![1]);
};

/** Let the panel's construction-time origin-doc fetch (and any pending
 *  re-stamp) settle before reading the html. */
const flush = () => new Promise((r) => setTimeout(r, 20));

/** A fetchImpl serving the given html (per-URL dispatch optional). */
function fetchServing(html: string, opts: { status?: number } = {}): typeof fetch {
  return ((_input: unknown, _init?: unknown) =>
    Promise.resolve(new Response(html, { status: opts.status ?? 200 }))) as unknown as typeof fetch;
}

const ORIGIN_A = new URL("http://127.0.0.1:43117/");
const ORIGIN_B = "http://127.0.0.1:43118/";

describe("ChatPanel — the amicode_build stamp on both HTML paths (#1556 / #1459)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    ChatPanel.buildIdFetchImpl = undefined;
    ChatPanel.buildChangeClock = undefined;
    ChatPanel.clearBuildIdLaneForTest();
  });

  it("stamps the iframe src with the served build id (normal path), preserving auth_token and every existing param", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(
      `<script type="module" crossorigin src="/assets/index-C8RDSfBx.js"></script>`,
    );
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    const password = mintServerPassword();
    const token = serverAuthToken(password);
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A, token, "/internal-scaffold");
    await flush();
    const src = iframeSrc(created[0].webview.html);
    expect(src.searchParams.get("amicode_build")).toBe("C8RDSfBx");
    // The stamp must not disturb the credential carriage or any existing param.
    expect(src.searchParams.get("auth_token")).toBe(token);
    expect(src.searchParams.get("colorScheme")).toBe("dark");
    expect(src.searchParams.get("amicode_hide_project")).toBe("/internal-scaffold");
    expect(src.origin).toBe("http://127.0.0.1:43117");
    // AC3-adjacent: the raw password still never appears anywhere in the html.
    expect(created[0].webview.html).not.toContain(password);
  });

  it("stamps the FIRST render when the origin's served id is already cached (later panels in the window)", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(
      `<script type="module" crossorigin src="/assets/index-aaa111.js"></script>`,
    );
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    // Warm the origin cache: the first panel's construction fetch observes the id.
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    await flush();
    created[0].dispose();
    // The next panel stamps on its first renderHtml — no await needed.
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    expect(iframeSrc(created[1].webview.html).searchParams.get("amicode_build")).toBe("aaa111");
  });

  it("stamps the transition path (adopt's splash shell) identically", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(
      `<script type="module" crossorigin src="/assets/index-bbb222.js"></script>`,
    );
    const existingPanel = vscode.window.createWebviewPanel(
      "amicode.onboarding",
      "Amicode Setup",
      vscode.ViewColumn.One,
      { enableScripts: true },
    ) as unknown as CapturedPanel;
    created.push(existingPanel);
    ChatPanel.adopt(existingPanel as unknown as import("vscode").WebviewPanel, fakeCtx(), ORIGIN_A, "tok");
    await flush();
    expect(existingPanel.webview.html).toContain("splash-overlay");
    expect(iframeSrc(existingPanel.webview.html).searchParams.get("amicode_build")).toBe("bbb222");
    expect(iframeSrc(existingPanel.webview.html).searchParams.get("auth_token")).toBe("tok");
  });

  it("undefined id (fetch failed / unparseable doc) → NO param set, auth_token intact (today's behavior)", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing("<html>no hashed entry here</html>", { status: 200 });
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A, "tok");
    await flush();
    const src = iframeSrc(created[0].webview.html);
    expect(src.searchParams.has("amicode_build")).toBe(false);
    expect(src.searchParams.get("auth_token")).toBe("tok");
  });

  it("a non-200 origin doc → NO param set (honest degradation, never an error)", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing("gone", { status: 404 });
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    await flush();
    expect(iframeSrc(created[0].webview.html).searchParams.has("amicode_build")).toBe(false);
  });

  it("reframe re-derives and re-stamps from the NEW origin (origin switches get the same guarantee)", async () => {
    ChatPanel.buildIdFetchImpl = ((_input: unknown) => {
      const url = String(_input);
      return Promise.resolve(
        new Response(
          url.startsWith(ORIGIN_B)
            ? `<script src="/assets/index-bbb222.js"></script>`
            : `<script src="/assets/index-aaa111.js"></script>`,
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A, "tok");
    await flush();
    expect(iframeSrc(created[0].webview.html).searchParams.get("amicode_build")).toBe("aaa111");

    ChatPanel.reframeAll(ORIGIN_B);
    expect(iframeSrc(created[0].webview.html).origin).toBe(ORIGIN_B.replace(/\/$/, ""));
    await flush();
    const src = iframeSrc(created[0].webview.html);
    expect(src.origin).toBe("http://127.0.0.1:43118");
    expect(src.searchParams.get("amicode_build")).toBe("bbb222");
    expect(src.searchParams.get("auth_token")).toBe("tok");
  });
});

describe("ChatPanel — the new-build prompt while the panel is alive (#1556)", () => {
  let restore: (() => void) | undefined;
  let created: CapturedPanel[] = [];
  let clockState: ReturnType<typeof manualClock> | undefined;
  let promptRestore: (() => void) | undefined;
  afterEach(() => {
    for (const p of created) p.dispose();
    restore?.();
    restore = undefined;
    created = [];
    promptRestore?.();
    promptRestore = undefined;
    ChatPanel.buildIdFetchImpl = undefined;
    ChatPanel.buildChangeClock = undefined;
    ChatPanel.clearBuildIdLaneForTest();
  });

  /** Capture the watchers' poll ticks instead of waiting the real 3-minute
   *  interval. Supports several live panels (one watcher each). */
  function manualClock(): { clock: BuildChangeClock; tickAll(): void; cleared: unknown[]; ms: number[] } {
    const cbs: Array<() => void> = [];
    const cleared: unknown[] = [];
    const ms: number[] = [];
    return {
      clock: {
        setInterval: (fn, interval) => {
          cbs.push(fn);
          ms.push(interval);
          return `watcher-handle-${cbs.length}`;
        },
        clearInterval: (h) => {
          cleared.push(h);
        },
      },
      tickAll: () => {
        for (const cb of [...cbs]) cb();
      },
      cleared,
      ms,
    };
  }

  it("prompts exactly once when a new build ships (Reload Window runs the reload command)", async () => {
    // Serve the current build first so the panel stamps "aaa111".
    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-aaa111.js"></script>`);
    const mc = manualClock();
    clockState = mc;
    ChatPanel.buildChangeClock = mc.clock;
    const prompts: Array<{ message: string; items: string[] }> = [];
    const w = vscode.window as unknown as { showInformationMessage: (m: string, ...i: string[]) => Promise<string | undefined> };
    const origPrompt = w.showInformationMessage;
    w.showInformationMessage = (m, ...items) => {
      prompts.push({ message: m, items });
      return Promise.resolve(RELOAD_WINDOW_BUTTON);
    };
    promptRestore = () => (w.showInformationMessage = origPrompt);

    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    await flush(); // panel stamped aaa111

    // A new ship lands while the panel is alive.
    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-bbb222.js"></script>`);
    (vscode.commands as unknown as { executed: string[] }).executed.length = 0;
    mc.tickAll();
    await flush();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].message).toBe("Amicode: a new app build is live (bbb222). Reload Window to pick it up.");
    expect(prompts[0].items).toEqual([RELOAD_WINDOW_BUTTON]);
    expect((vscode.commands as unknown as { executed: string[] }).executed).toContain("workbench.action.reloadWindow");

    // Once-per-version: a later poll of the SAME served id never re-prompts.
    prompts.length = 0;
    mc.tickAll();
    await flush();
    expect(prompts).toHaveLength(0);
  });

  it("a ship prompts EXACTLY once across multiple live panels (side-by-side tabs share the window's prompted set)", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-aaa111.js"></script>`);
    const mc = manualClock();
    ChatPanel.buildChangeClock = mc.clock;
    const prompts: string[] = [];
    const w = vscode.window as unknown as { showInformationMessage: (m: string, ...i: string[]) => Promise<string | undefined> };
    const origPrompt = w.showInformationMessage;
    w.showInformationMessage = (m) => {
      prompts.push(m);
      return Promise.resolve(undefined);
    };
    promptRestore = () => (w.showInformationMessage = origPrompt);

    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    ChatPanel.openNew(fakeCtx(), ORIGIN_A);
    await flush();

    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-ccc333.js"></script>`);
    mc.tickAll(); // both panels' watchers poll
    await flush();
    expect(prompts).toEqual([
      "Amicode: a new app build is live (ccc333). Reload Window to pick it up.",
    ]);
  });

  it("never prompts when the panel is current (served === stamped)", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-aaa111.js"></script>`);
    const mc = manualClock();
    ChatPanel.buildChangeClock = mc.clock;
    const w = vscode.window as unknown as { showInformationMessage: (m: string, ...i: string[]) => Promise<string | undefined> };
    const origPrompt = w.showInformationMessage;
    const calls: string[] = [];
    w.showInformationMessage = (m) => {
      calls.push(m);
      return Promise.resolve(undefined);
    };
    promptRestore = () => (w.showInformationMessage = origPrompt);

    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    await flush();
    mc.tickAll();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("polls on the named slow interval and dispose stops the polling with the panel", async () => {
    ChatPanel.buildIdFetchImpl = fetchServing(`<script src="/assets/index-aaa111.js"></script>`);
    const mc = manualClock();
    ChatPanel.buildChangeClock = mc.clock;
    const cap = capturePanel();
    restore = cap.restore;
    created = cap.created;
    ChatPanel.openOrReveal(fakeCtx(), ORIGIN_A);
    await flush();
    expect(mc.ms).toEqual([BUILD_CHANGE_POLL_INTERVAL_MS]);
    created[0].dispose();
    expect(mc.cleared).toContain("watcher-handle-1");
  });
});
