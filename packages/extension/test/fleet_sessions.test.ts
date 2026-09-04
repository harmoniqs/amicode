// Tests for the read-only Fleet Sessions tree view (amicode#779): list hub
// sessions from a standalone client over the tunnel, click-to-reattach-and-pin,
// an honest degraded state when the hub is unreachable, strict read-only, and
// view absence on machines that have never been fleet clients.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  FleetSessionsProvider,
  fetchHubSessions,
  parseHubSessions,
  hubDisplayName,
  makeReattach,
  fleetClientContextValue,
  formatSessionTimestamp,
  FLEET_SESSIONS_VIEW_ID,
  FLEET_CLIENT_CONTEXT_KEY,
  type HubSession,
} from "../src/fleet_sessions";
import { getFleetRole } from "../src/fleet_fallback";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")) as {
  contributes?: { views?: Record<string, Array<{ id?: string; when?: string; name?: string }>>; menus?: unknown };
};

// ── fixtures ────────────────────────────────────────────────────────────────

const sessionInfo = (over: Record<string, unknown> = {}) => ({
  id: "ses_1",
  title: "CZ gate tuning",
  directory: "/Users/aaron/armonia/repos/amicode",
  time: { created: 1_000, updated: 2_000 },
  ...over,
});

type RecordedCall = { url: string; method: string; headers: Record<string, string> };
function fetchStub(responses: Array<{ ok?: boolean; status?: number; body?: unknown } | Error>) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TREE = async (p: FleetSessionsProvider) => {
  const kids = await p.getChildren();
  return kids.map((k) => ({ item: k, tree: p.getTreeItem(k) as vscode.TreeItem }));
};

// ── AC1: list the hub's sessions (title, last-updated) over the tunnel ──────

describe("AC1 — hub session list over the tunnel", () => {
  it("fetches GET /session scoped to the project directory with auth, raising the attach flow's limit", async () => {
    const { impl, calls } = fetchStub([{ body: [sessionInfo()] }]);
    const sessions = await fetchHubSessions("http://127.0.0.1:4096", {
      directory: "/Users/aaron/armonia/repos/amicode",
      authorization: "Basic dGVzdA==",
      fetchImpl: impl,
    });
    expect(sessions).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("http://127.0.0.1:4096");
    expect(url.pathname).toBe("/session");
    expect(url.searchParams.get("directory")).toBe("/Users/aaron/armonia/repos/amicode");
    // limit raised above the attach flow's 1 — the view lists, not pins
    expect(Number(url.searchParams.get("limit"))).toBeGreaterThan(1);
    expect(calls[0]!.headers["Authorization"]).toBe("Basic dGVzdA==");
  });

  it("omits the directory scope when there is no workspace folder (server cwd scope)", async () => {
    const { impl, calls } = fetchStub([{ body: [] }]);
    await fetchHubSessions("http://127.0.0.1:4096", { fetchImpl: impl });
    expect(new URL(calls[0]!.url).searchParams.has("directory")).toBe(false);
  });

  it("parses Session.Info rows into {id, title, updated}, root sessions only, newest first", () => {
    const parsed = parseHubSessions([
      sessionInfo(),
      sessionInfo({ id: "ses_2", title: "older", parentID: "ses_1", time: { created: 5, updated: 9_999 } }),
      sessionInfo({ id: "ses_3", title: "newer", time: { created: 5, updated: 3_000 } }),
      { not: "a session" },
    ]);
    expect(parsed.map((s) => s.id)).toEqual(["ses_3", "ses_1"]);
    expect(parsed[0]).toMatchObject<Partial<HubSession>>({ id: "ses_3", title: "newer", updated: 3_000 });
  });

  it("renders each session as a tree item: title label, last-updated description, open command", async () => {
    const provider = new FleetSessionsProvider({
      hubName: "amico-erlich",
      fetchSessions: async () => [{ id: "ses_1", title: "CZ gate tuning", updated: 2_000 }],
      reattach: () => {},
    });
    const rows = await TREE(provider);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tree.label).toBe("CZ gate tuning");
    expect(rows[0]!.tree.description).toBeTruthy(); // the last-updated timestamp
    const cmd = rows[0]!.tree.command as { command: string; arguments?: unknown[] };
    expect(cmd.command).toBe("amicode.fleetSessions.open");
    expect(cmd.arguments?.[0]).toBe(rows[0]!.item);
  });

  it("refreshes by re-fetching — every getChildren goes back to the hub (no stale cache beyond the visible list)", async () => {
    let n = 0;
    const provider = new FleetSessionsProvider({
      hubName: "hub",
      fetchSessions: async () => {
        n++;
        return [];
      },
      reattach: () => {},
    });
    await provider.getChildren();
    await provider.getChildren();
    expect(n).toBe(2);
  });

  it("exposes a refresh() that re-queries the hub on demand (hub state transitions)", async () => {
    let n = 0;
    const provider = new FleetSessionsProvider({
      hubName: "hub",
      fetchSessions: async () => {
        n++;
        return [];
      },
      reattach: () => {},
    });
    const fired: unknown[] = [];
    provider.onDidChangeTreeData(() => fired.push(1));
    provider.refresh();
    expect(fired).toHaveLength(1);
    await provider.getChildren();
    expect(n).toBe(1);
  });

  it("formats last-updated as a compact relative time", () => {
    const now = 1_000_000;
    expect(formatSessionTimestamp(now - 30_000, now)).toBe("just now");
    expect(formatSessionTimestamp(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatSessionTimestamp(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatSessionTimestamp(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatSessionTimestamp(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── AC2: click → reattach to the hub with that session pinned and open ─────

describe("AC2 — click-to-reattach-and-pin", () => {
  const posted: unknown[] = [];
  const panel = { postMessage: (m: unknown) => {
    posted.push(m);
    return Promise.resolve(true);
  } };

  it("opens the panel against the hub tunnel URL and navigates it to the pinned session", async () => {
    posted.length = 0;
    let openedWith: URL | undefined;
    let appReadyCb: (() => void) | undefined;
    const reattach = makeReattach({
      readyUrl: () => new URL("http://127.0.0.1:4096"),
      openOrReveal: (url) => {
        openedWith = url;
        return panel;
      },
      onAppReady: (cb) => {
        appReadyCb = cb;
      },
      warn: () => {},
    });
    reattach("ses_42");
    expect(openedWith?.toString()).toBe("http://127.0.0.1:4096/");
    expect(posted).toContainEqual({ source: "amicode", kind: "navigate", path: "/session/ses_42" });
    // dual-send: the fresh-panel path re-posts once the app signals ready
    expect(appReadyCb).toBeTruthy();
    const before = posted.length;
    appReadyCb!();
    expect(posted.length).toBe(before + 1);
    expect(posted).toContainEqual({ source: "amicode", kind: "navigate", path: "/session/ses_42" });
  });

  it("never opens against a dead tunnel — warns instead", () => {
    posted.length = 0;
    const warnings: string[] = [];
    const reattach = makeReattach({
      readyUrl: () => undefined,
      openOrReveal: () => {
        throw new Error("must not open");
      },
      onAppReady: () => {},
      warn: (m) => warnings.push(m),
    });
    reattach("ses_42");
    expect(posted).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

// ── AC3: hub unreachable → explicit degraded state naming where sessions live

describe("AC3 — degraded state when the hub is unreachable", () => {
  it("shows exactly one item naming the hub — never an empty list", async () => {
    const { impl } = fetchStub([new Error("tunnel down")]);
    const provider = new FleetSessionsProvider({
      hubName: "amico-erlich",
      fetchSessions: () => fetchHubSessions("http://127.0.0.1:4096", { fetchImpl: impl }),
      reattach: () => {},
    });
    const rows = await TREE(provider);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tree.label).toContain("amico-erlich");
    expect(rows[0]!.tree.label).toContain("Sessions live on");
    expect(rows[0]!.tree.tooltip).toBeTruthy();
    expect(rows[0]!.tree.command).toBeUndefined(); // nothing to open while degraded
  });

  it("a genuinely empty hub says so honestly (hub reachable, zero sessions)", async () => {
    const { impl } = fetchStub([{ body: [] }]);
    const provider = new FleetSessionsProvider({
      hubName: "amico-erlich",
      fetchSessions: () => fetchHubSessions("http://127.0.0.1:4096", { fetchImpl: impl }),
      reattach: () => {},
    });
    const rows = await TREE(provider);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tree.label).toContain("No sessions");
  });

  it("names the hub from the fleet config's sshAlias", () => {
    expect(hubDisplayName({ role: "client", canonical: { sshAlias: "amico-erlich", host: "h" } })).toBe("amico-erlich");
    expect(hubDisplayName({ role: "client", canonical: { host: "10.0.0.2" } })).toBe("10.0.0.2");
    expect(hubDisplayName(null)).toBe("the hub");
  });
});

// ── AC4: strictly read-only ─────────────────────────────────────────────────

describe("AC4 — the view is strictly read-only", () => {
  it("only ever speaks GET to the hub", async () => {
    const { impl, calls } = fetchStub([{ body: [sessionInfo()] }, { body: [] }]);
    await fetchHubSessions("http://127.0.0.1:4096", { fetchImpl: impl });
    await fetchHubSessions("http://127.0.0.1:4096", { fetchImpl: impl });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.method).toBe("GET");
  });

  it("exposes no mutation affordances: session items carry no rename/delete context menu", async () => {
    const provider = new FleetSessionsProvider({
      hubName: "hub",
      fetchSessions: async () => [{ id: "ses_1", title: "t", updated: 1 }],
      reattach: () => {},
    });
    const rows = await TREE(provider);
    const cmds = rows.map((r) => (r.tree.command as { command?: string } | undefined)?.command);
    for (const c of cmds) expect(c).toBe("amicode.fleetSessions.open");
    const pkgStr = JSON.stringify(pkg);
    expect(pkgStr).not.toMatch(/fleetSession.*(delete|rename|create|remove)/i);
    expect(pkgStr).not.toMatch(/(delete|rename|remove).*[Ff]leet [Ss]ession/);
  });
});

// ── AC5: absent (not an empty stub) on machines that were never clients ────

describe("AC5 — the view is absent on never-fleet-client machines", () => {
  it("the contributed view is gated on the amicode.fleetClient context key", () => {
    const views = pkg.contributes?.views?.amicode ?? [];
    const view = views.find((v) => v.id === FLEET_SESSIONS_VIEW_ID);
    expect(view).toBeTruthy();
    expect(view!.when).toBe(FLEET_CLIENT_CONTEXT_KEY);
  });

  it("the context key is true only for role=client in fleet.json", () => {
    expect(fleetClientContextValue("client")).toBe(true);
    expect(fleetClientContextValue("standalone")).toBe(false);
    expect(fleetClientContextValue("server")).toBe(false);
  });

  it("no fleet.json (never enrolled) reads as standalone → the view stays hidden", () => {
    const role = getFleetRole("/nonexistent/fleet.json", () => {
      throw new Error("no file");
    });
    expect(fleetClientContextValue(role)).toBe(false);
  });
});
