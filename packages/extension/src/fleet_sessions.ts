// fleet_sessions.ts — the read-only Fleet Sessions tree view (amicode#779).
//
// When a fleet client goes standalone, its Sessions dropdown points at the
// empty local store and the canonical hub sessions become unlistable. This
// view lists the hub's sessions over the existing tunnel — the same
// `GET /session?directory=…` collection route the attach/bug-report flows
// use — and reattaches the chat panel to the hub with a clicked session
// pinned (the fork's AmicodeNavigateBridge opens `/session/:id`).
//
// Invariants:
//   - Strictly read-only: the ONLY outbound verb here is GET. No create,
//     rename, delete, or any other mutation route is ever called.
//   - Hub unreachable → one explicit "Sessions live on <hub>" item. Never an
//     empty list (which would imply there are no sessions).
//   - View visibility is gated on the `amicode.fleetClient` context key
//     (role=client in ~/.amico/ops/fleet/fleet.json), so machines that were
//     never fleet clients don't even see a stub.
//   - Refresh on view open (native getChildren) and on hub state transitions
//     (the attach poll calls refresh()) — never on a timer.
//
// No session data is persisted client-side beyond the visible list.

import * as vscode from "vscode";
import type { FleetConfig } from "./fleet_fallback";

export const FLEET_SESSIONS_VIEW_ID = "amicode.fleetSessions";
export const FLEET_CLIENT_CONTEXT_KEY = "amicode.fleetClient";
/** The attach flow pins with limit=1; the view lists, so the limit is raised.
 *  200 comfortably covers the ~130-session hub this bridge exists for. */
export const FLEET_SESSIONS_LIMIT = 200;

export interface HubSession {
  id: string;
  title: string;
  /** Last-updated epoch ms (falls back to created). */
  updated: number;
}

/** The human hub name for the degraded state: sshAlias → host → "the hub". */
export function hubDisplayName(cfg: FleetConfig | null | undefined): string {
  const alias = cfg?.canonical?.sshAlias?.trim();
  if (alias) return alias;
  const host = cfg?.canonical?.host?.trim();
  if (host) return host;
  return "the hub";
}

/** The view-visibility context value: true only for role=client. */
export function fleetClientContextValue(role: string): boolean {
  return role === "client";
}

/** Parse the hub's Session.Info array into view rows: root sessions only
 *  (children are fork/subagent chatter, same rule the bug-report provenance
 *  scan applies), title + last-updated, newest first, malformed rows dropped. */
export function parseHubSessions(body: unknown): HubSession[] {
  if (!Array.isArray(body)) return [];
  const rows: HubSession[] = [];
  for (const s of body) {
    if (!s || typeof s !== "object") continue;
    const rec = s as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id === "") continue;
    if (typeof rec.parentID === "string" && rec.parentID !== "") continue;
    const time = (rec.time ?? {}) as Record<string, unknown>;
    const updated = typeof time.updated === "number" ? time.updated : typeof time.created === "number" ? time.created : 0;
    rows.push({ id: rec.id, title: typeof rec.title === "string" ? rec.title : rec.id, updated });
  }
  rows.sort((a, b) => b.updated - a.updated);
  return rows;
}

/** GET the hub's session collection over the tunnel. GET-only by construction:
 *  there is no code path here that can issue anything else. */
export async function fetchHubSessions(
  baseUrl: string | URL,
  opts: { directory?: string; limit?: number; authorization?: string; fetchImpl?: typeof fetch } = {},
): Promise<HubSession[]> {
  const url = new URL("/session", baseUrl);
  if (opts.directory) url.searchParams.set("directory", opts.directory);
  url.searchParams.set("limit", String(opts.limit ?? FLEET_SESSIONS_LIMIT));
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "GET",
    headers: opts.authorization ? { Authorization: opts.authorization } : undefined,
  });
  if (!res.ok) throw new Error(`hub session list failed (HTTP ${res.status})`);
  return parseHubSessions(await res.json());
}

/** Compact relative timestamp for a session's last-updated time. */
export function formatSessionTimestamp(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export type FleetSessionsItemKind = "session" | "degraded" | "empty";

/** One tree row. `kind=session` rows are the only ones with a command. */
export class FleetSessionsItem {
  constructor(
    public readonly label: string,
    public readonly kind: FleetSessionsItemKind,
    public readonly description?: string,
    public readonly tooltip?: string,
    public readonly session?: HubSession,
  ) {}
}

/** Click-to-reattach: open (or reveal) the chat panel against the hub tunnel
 *  URL and post the fork's navigate envelope for `/session/:id` — dual-send
 *  (immediate + on app-ready) exactly like the new-project flow, so a freshly
 *  created panel receives it once the app is mounted. */
export function makeReattach(deps: {
  readyUrl: () => URL | undefined;
  openOrReveal: (url: URL) => { postMessage: (msg: unknown) => unknown } | undefined;
  onAppReady: (cb: () => void) => void;
  warn: (msg: string) => void;
}): (sessionId: string) => void {
  return (sessionId: string) => {
    const url = deps.readyUrl();
    if (!url) {
      deps.warn("Amicode: the hub is unreachable — sessions live on the hub. Reattach the fleet tunnel, then try again.");
      return;
    }
    const panel = deps.openOrReveal(url);
    if (!panel) return;
    const envelope = { source: "amicode", kind: "navigate", path: `/session/${sessionId}` };
    const send = () => void panel.postMessage(envelope);
    send();
    deps.onAppReady(send);
  };
}

export interface FleetSessionsDeps {
  hubName: string;
  fetchSessions: () => Promise<HubSession[]>;
  reattach: (sessionId: string) => void;
}

/** The tree data provider. Read-only by shape: session rows carry exactly one
 *  command (open), and no mutation context/menu exists anywhere for them. */
export class FleetSessionsProvider implements vscode.TreeDataProvider<FleetSessionsItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FleetSessionsItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: FleetSessionsDeps) {}

  /** Reattach the chat panel to the hub with the given session pinned/open. */
  readonly reattach = (sessionId: string): void => this.deps.reattach(sessionId);

  /** Called on hub state transitions (attach/regain) from the tunnel poll. */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  async getChildren(): Promise<FleetSessionsItem[]> {
    try {
      const sessions = await this.deps.fetchSessions();
      if (sessions.length === 0) {
        return [new FleetSessionsItem(`No sessions on ${this.deps.hubName} yet`, "empty")];
      }
      return sessions.map(
        (s) =>
          new FleetSessionsItem(
            s.title,
            "session",
            formatSessionTimestamp(s.updated),
            `${s.title}\nLast updated ${formatSessionTimestamp(s.updated)}\nsession ${s.id}`,
            s,
          ),
      );
    } catch {
      // Degraded, not empty: name where the sessions actually live (AC3).
      return [
        new FleetSessionsItem(
          `Sessions live on ${this.deps.hubName}`,
          "degraded",
          undefined,
          `The fleet tunnel to ${this.deps.hubName} is down, so hub sessions can't be listed. ` +
            `Reattach the tunnel (or check Amicode — opencode output) and this view will refresh.`,
        ),
      ];
    }
  }

  getTreeItem(item: FleetSessionsItem): vscode.TreeItem {
    const tree = new vscode.TreeItem(item.label);
    tree.description = item.description;
    tree.tooltip = item.tooltip;
    if (item.kind === "session" && item.session) {
      tree.command = {
        command: "amicode.fleetSessions.open",
        title: "Open on hub",
        arguments: [item],
      };
      tree.contextValue = "fleetSession";
    }
    return tree;
  }
}
