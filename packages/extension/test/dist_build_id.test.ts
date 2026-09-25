import { describe, it, expect } from "vitest";
import {
  distBuildIdFromIndexHtml,
  fetchServedBuildId,
  BuildChangeWatcher,
  BUILD_CHANGE_POLL_INTERVAL_MS,
  RELOAD_WINDOW_BUTTON,
  type BuildChangeClock,
} from "../src/dist_build_id";

// ============================================================================
// #1556 (subsuming #1459) — the build-id primitives of the live-test reload
// lane. The served dist's index.html names its entry asset with its content
// hash (`/assets/index-<hash>.js`, minted fresh by every vite build), so the
// hash IS the build id: the extension host can fetch the origin doc (its
// fetches bypass the webview service worker — that's the whole tractability
// of #1556) and derive the served version even while the framed app is stuck
// on the previous ship (#1459's SW-stale-index diagnosis). Everything here is
// fail-soft: an unparseable doc or failed fetch is undefined, never a throw —
// a degraded origin must degrade honestly, never break the panel.
// ============================================================================

/** The real built-dist shape (vite production build of packages/app, staged
 *  into the extension's dist/app by build_app_bundle.mjs): the entry rides
 *  /assets/index-<hash>.js, the stylesheet a DIFFERENT hash — only the .js
 *  reference is the build id. */
const BUILT_INDEX_HTML = `<!doctype html>
<html lang="en" style="background-color: var(--v2-background-bg-deep, #ffffff)">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content, viewport-fit=cover" />
    <title>Amicode</title>
    <link rel="icon" type="image/png" href="/favicon-96x96-v3.png" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="/amico.svg" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#ffffff" />
    <script id="oc-theme-preload-script">;(function () { /* inlined by the build */ })()</script>
    <script type="module" crossorigin src="/assets/index-C8RDSfBx.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-So3MfOBb.css">
  </head>
  <body class="antialiased overscroll-none text-12-regular overflow-hidden bg-v2-background-bg-deep">
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root" class="flex flex-col h-dvh bg-v2-background-bg-deep p-px"></div>
  </body>
</html>`;

/** The dev overlay's index.html (packages/app-bundle/overlay/…/index.html)
 *  references the unbundled source entry — no hashed asset, so NO build id. */
const DEV_OVERLAY_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Amicode</title></head>
  <body>
    <div id="root"></div>
    <script src="/src/entry.tsx" type="module"></script>
  </body>
</html>`;

describe("distBuildIdFromIndexHtml — derive the build id from the served origin doc (#1556)", () => {
  it("derives the id from the built dist's entry asset (the real index.html shape), not the css asset's hash", () => {
    expect(distBuildIdFromIndexHtml(BUILT_INDEX_HTML)).toBe("C8RDSfBx");
  });

  it("matches the entry wherever the path points it (root-relative src, quoted href)", () => {
    expect(distBuildIdFromIndexHtml(`<script src="index-abc123.js"></script>`)).toBe("abc123");
  });

  it("accepts the full hash charset — letters, digits, underscore, dash, mixed case", () => {
    expect(distBuildIdFromIndexHtml(`<script src="/assets/index-Ab_9-xZ7.js"></script>`)).toBe("Ab_9-xZ7");
  });

  it("returns the FIRST entry reference when multiple index-<id>.js refs appear", () => {
    const html = `<script src="/assets/index-aaa.js"></script><script src="/assets/index-bbb.js"></script>`;
    expect(distBuildIdFromIndexHtml(html)).toBe("aaa");
  });

  it("returns undefined on no-match (the dev overlay's /src/entry.tsx shape)", () => {
    expect(distBuildIdFromIndexHtml(DEV_OVERLAY_INDEX_HTML)).toBeUndefined();
  });

  it("returns undefined on empty input", () => {
    expect(distBuildIdFromIndexHtml("")).toBeUndefined();
  });

  it("never mistakes a differently-named asset for the entry", () => {
    expect(distBuildIdFromIndexHtml(`<script src="/assets/my-index-abc.js"></script>`)).toBeUndefined();
  });
});

describe("fetchServedBuildId — the host-side origin-doc fetch (never throws) (#1556)", () => {
  const ORIGIN = "http://127.0.0.1:43117";

  it("GETs the origin document and derives the served build id", async () => {
    const urls: string[] = [];
    const impl: typeof fetch = (input, init) => {
      urls.push(String(input));
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
      return Promise.resolve(new Response(BUILT_INDEX_HTML, { status: 200 }));
    };
    await expect(fetchServedBuildId(ORIGIN, undefined, impl)).resolves.toBe("C8RDSfBx");
    expect(urls).toEqual([`${ORIGIN}/`]);
  });

  it("targets the ORIGIN document even when handed a deeper URL", async () => {
    const urls: string[] = [];
    const impl: typeof fetch = (input) => {
      urls.push(String(input));
      return Promise.resolve(new Response(BUILT_INDEX_HTML, { status: 200 }));
    };
    await expect(fetchServedBuildId(`${ORIGIN}/session/abc`, undefined, impl)).resolves.toBe("C8RDSfBx");
    expect(urls).toEqual([`${ORIGIN}/`]);
  });

  it("non-200 → undefined (never throws)", async () => {
    for (const status of [404, 500, 302]) {
      const impl: typeof fetch = () => Promise.resolve(new Response("nope", { status }));
      await expect(fetchServedBuildId(ORIGIN, undefined, impl)).resolves.toBeUndefined();
    }
  });

  it("fetch rejection → undefined (never throws)", async () => {
    const impl: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(fetchServedBuildId(ORIGIN, undefined, impl)).resolves.toBeUndefined();
  });

  it("200 with an unparseable body → undefined", async () => {
    const impl: typeof fetch = () => Promise.resolve(new Response(DEV_OVERLAY_INDEX_HTML, { status: 200 }));
    await expect(fetchServedBuildId(ORIGIN, undefined, impl)).resolves.toBeUndefined();
  });

  it("malformed origin → undefined (never throws)", async () => {
    await expect(fetchServedBuildId("not a url")).resolves.toBeUndefined();
  });
});

/** Manual clock: captures the interval callback so tests drive polls
 *  deterministically (the production watcher waits minutes between ticks). */
function manualClock(): { clock: BuildChangeClock; tick(): void; cleared: unknown[]; ms: number[] } {
  let cb: (() => void) | undefined;
  const cleared: unknown[] = [];
  const ms: number[] = [];
  return {
    clock: {
      setInterval: (fn, interval) => {
        cb = fn;
        ms.push(interval);
        return "handle-1";
      },
      clearInterval: (h) => {
        cleared.push(h);
      },
    },
    tick: () => cb?.(),
    cleared,
    ms,
  };
}

/** A watcher wired to a controllable served id, stamped id and prompt. */
function rig(opts: { served?: string; stamped?: string; choice?: string | undefined }) {
  const prompted: Array<{ message: string; items: string[] }> = [];
  const reloads: number[] = [];
  const state = { served: opts.served, stamped: opts.stamped };
  const { clock, tick, cleared, ms } = manualClock();
  const watcher = new BuildChangeWatcher({
    origin: () => "http://127.0.0.1:43117",
    stampedBuildId: () => state.stamped,
    fetchServed: async () => state.served,
    prompt: async (message, ...items) => {
      prompted.push({ message, items });
      return opts.choice;
    },
    reload: () => reloads.push(reloads.length + 1),
    clock,
  });
  return { watcher, tick, cleared, ms, prompted, reloads, state };
}

describe("BuildChangeWatcher — the new-build prompt (once per version) (#1556)", () => {
  it("polls on the slow named interval (3 minutes — one small GET)", () => {
    const { ms } = rig({ served: "aaa", stamped: "aaa" });
    expect(ms).toEqual([BUILD_CHANGE_POLL_INTERVAL_MS]);
    expect(BUILD_CHANGE_POLL_INTERVAL_MS).toBe(3 * 60 * 1000);
  });

  it("prompts exactly once per version: the same served id on later ticks never re-prompts", async () => {
    const r = rig({ served: "bbb", stamped: "aaa", choice: undefined });
    r.tick();
    await r.watcher.poll();
    r.tick();
    await r.watcher.poll();
    expect(r.prompted).toHaveLength(1);
  });

  it("a newer id after a decline prompts again (one prompt per version, versions are unbounded)", async () => {
    const r = rig({ served: "bbb", stamped: "aaa", choice: undefined });
    await r.watcher.poll(); // declined bbb
    r.state.served = "ccc";
    await r.watcher.poll(); // ccc is a new version → prompt again
    expect(r.prompted.map((p) => p.message)).toEqual([
      `Amicode: a new app build is live (bbb). Reload Window to pick it up.`,
      `Amicode: a new app build is live (ccc). Reload Window to pick it up.`,
    ]);
  });

  it("the prompt offers Reload Window and clicking it runs the reload", async () => {
    const r = rig({ served: "bbb", stamped: "aaa", choice: RELOAD_WINDOW_BUTTON });
    await r.watcher.poll();
    expect(r.prompted[0].items).toEqual([RELOAD_WINDOW_BUTTON]);
    expect(r.reloads).toHaveLength(1);
  });

  it("served undefined (fetch failed) → never prompts, never compares", async () => {
    const r = rig({ served: undefined, stamped: "aaa" });
    await r.watcher.poll();
    expect(r.prompted).toHaveLength(0);
  });

  it("served === stamped → no prompt (the panel is current)", async () => {
    const r = rig({ served: "aaa", stamped: "aaa" });
    await r.watcher.poll();
    expect(r.prompted).toHaveLength(0);
  });

  it("a stamped-undefined panel (construction fetch failed) still prompts — the baseline is unknown, not current", async () => {
    const r = rig({ served: "bbb", stamped: undefined, choice: undefined });
    await r.watcher.poll();
    expect(r.prompted).toHaveLength(1);
  });

  it("dispose stops the polling: the interval handle is cleared and later ticks no-op", async () => {
    const r = rig({ served: "bbb", stamped: "aaa" });
    r.watcher.dispose();
    expect(r.cleared).toEqual(["handle-1"]);
    r.tick();
    await r.watcher.poll();
    expect(r.prompted).toHaveLength(0);
  });

  it("a shared prompted set means a ship prompts exactly once across a window's watchers (multi-tab AC)", async () => {
    const prompted = new Set<string>();
    const promptedLog: string[] = [];
    const mk = () =>
      new BuildChangeWatcher({
        origin: () => "http://127.0.0.1:43117",
        stampedBuildId: () => "aaa",
        fetchServed: async () => "bbb",
        prompt: async (message) => {
          promptedLog.push(message);
          return undefined;
        },
        reload: () => {},
        prompted,
      });
    const w1 = mk();
    const w2 = mk();
    await w1.poll();
    await w2.poll(); // the second tab's watcher must see the version as already prompted
    expect(promptedLog).toHaveLength(1);
  });
});
