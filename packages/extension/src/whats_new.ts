// whats_new.ts — #2001: the extension host's half of the What's-new page.
//
// The page itself lives in the app overlay (web and VS Code share it); the
// extension owns only:
//   - the LAST-SEEN VERSION, in globalState (per machine). The app asks over
//     the bridge (whats-new-query → whats-new-state {lastSeen}) and records the
//     version on Continue / Esc (whats-new-seen {version});
//   - the palette command "Amicode: What's New" (amicode.whatsNew), which
//     broadcasts open-whats-new to the live chat webviews (the
//     open-fleet-manager pattern, fleet_manager_command.ts).
//
// An install with NO recorded version but other globalState is an UPGRADE from
// before this page existed → it reads as LEGACY_BASELINE_VERSION (the last
// release without the page), so its user sees what changed, not the welcome.
// A truly empty globalState is a fresh install → null → the welcome card.
import * as vscode from "vscode";

export const WHATS_NEW_LAST_SEEN_KEY = "amicode.whatsNew.lastSeenVersion";
/** The last release that shipped without the What's-new page. */
export const LEGACY_BASELINE_VERSION = "0.3.10";
export const OPEN_WHATS_NEW_KIND = "open-whats-new" as const;

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface WhatsNewMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
  keys?(): readonly string[];
}

let store: WhatsNewMemento | undefined;

/** Wire the globalState at activation (before any panel opens). */
export function configureWhatsNew(memento: WhatsNewMemento): void {
  store = memento;
}

export function lastSeenVersion(memento: WhatsNewMemento | undefined = store): string | null {
  if (!memento) return null;
  const v = memento.get<unknown>(WHATS_NEW_LAST_SEEN_KEY);
  if (typeof v === "string" && VERSION_RE.test(v)) return v;
  const others = (memento.keys?.() ?? []).filter((k) => k !== WHATS_NEW_LAST_SEEN_KEY);
  return others.length > 0 ? LEGACY_BASELINE_VERSION : null;
}

/** The two bridge kinds. Returns true when consumed (junk is consumed and
 *  dropped — the bridge never echoes untrusted payloads). */
export function handleWhatsNewBridgeMessage(msg: unknown, postToWebview: (m: unknown) => void): boolean {
  if (!msg || typeof msg !== "object" || (msg as { source?: unknown }).source !== "amicode") return false;
  const d = msg as { kind?: unknown; tab?: string; version?: unknown };
  if (d.kind === "whats-new-query") {
    postToWebview({ source: "amicode", kind: "whats-new-state", lastSeen: lastSeenVersion(), tab: d.tab });
    return true;
  }
  if (d.kind === "whats-new-seen") {
    if (typeof d.version === "string" && d.version.length <= 64 && VERSION_RE.test(d.version)) {
      void store?.update(WHATS_NEW_LAST_SEEN_KEY, d.version);
    }
    return true;
  }
  return false;
}

export function registerWhatsNewCommand(
  ctx: vscode.ExtensionContext,
  deps: { postToAll: (msg: { source: "amicode"; kind: typeof OPEN_WHATS_NEW_KIND }) => void },
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.whatsNew", () => {
      deps.postToAll({ source: "amicode", kind: OPEN_WHATS_NEW_KIND });
    }),
  );
}
