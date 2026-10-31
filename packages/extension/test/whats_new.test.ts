// #2001 — the extension host's half of the What's-new page: the last-seen
// version lives in globalState (per machine); the app asks for it over the
// bridge (whats-new-query → whats-new-state), records it on Continue/Esc
// (whats-new-seen), and the palette command "Amicode: What's New" reopens the
// page by broadcasting open-whats-new to the live chat webviews.
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  LEGACY_BASELINE_VERSION,
  WHATS_NEW_LAST_SEEN_KEY,
  configureWhatsNew,
  handleWhatsNewBridgeMessage,
  lastSeenVersion,
  registerWhatsNewCommand,
} from "../src/whats_new";
import { handleAmicodeBridgeMessage } from "../src/chat_bridge";

function memento(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
    keys: () => [...data.keys()],
  };
}

describe("lastSeenVersion", () => {
  it("a recorded version wins", () => {
    expect(lastSeenVersion(memento({ [WHATS_NEW_LAST_SEEN_KEY]: "0.3.10" }))).toBe("0.3.10");
  });
  it("a truly fresh install (empty globalState) → null (the welcome card)", () => {
    expect(lastSeenVersion(memento())).toBeNull();
  });
  it("an upgrade from before the page existed (other state, no key) → the legacy baseline", () => {
    expect(lastSeenVersion(memento({ "amicode.vaultSetup.dismissed": true }))).toBe(LEGACY_BASELINE_VERSION);
    expect(LEGACY_BASELINE_VERSION).toBe("0.3.10");
  });
});

describe("the bridge kinds", () => {
  it("whats-new-query answers whats-new-state with the last seen version, echoing tab", () => {
    const m = memento({ [WHATS_NEW_LAST_SEEN_KEY]: "0.3.9" });
    configureWhatsNew(m);
    const posted: unknown[] = [];
    expect(handleWhatsNewBridgeMessage({ source: "amicode", kind: "whats-new-query", tab: "t1" }, (x) => posted.push(x))).toBe(true);
    expect(posted).toEqual([{ source: "amicode", kind: "whats-new-state", lastSeen: "0.3.9", tab: "t1" }]);
  });

  it("whats-new-seen records a bounded semver-ish version; junk is consumed and dropped", () => {
    const m = memento();
    configureWhatsNew(m);
    expect(handleWhatsNewBridgeMessage({ source: "amicode", kind: "whats-new-seen", version: "0.4.0" }, () => {})).toBe(true);
    expect(m.data.get(WHATS_NEW_LAST_SEEN_KEY)).toBe("0.4.0");
    expect(handleWhatsNewBridgeMessage({ source: "amicode", kind: "whats-new-seen", version: "<script>" }, () => {})).toBe(true);
    expect(handleWhatsNewBridgeMessage({ source: "amicode", kind: "whats-new-seen", version: 4 }, () => {})).toBe(true);
    expect(m.data.get(WHATS_NEW_LAST_SEEN_KEY)).toBe("0.4.0");
  });

  it("other kinds are not consumed", () => {
    expect(handleWhatsNewBridgeMessage({ source: "amicode", kind: "theme" }, () => {})).toBe(false);
    expect(handleWhatsNewBridgeMessage("nope", () => {})).toBe(false);
  });

  it("the shared chat bridge routes the kinds (chat panel + deck)", () => {
    const m = memento({ [WHATS_NEW_LAST_SEEN_KEY]: "0.3.10" });
    configureWhatsNew(m);
    const postToWebview = vi.fn();
    const handled = handleAmicodeBridgeMessage(
      { source: "amicode", kind: "whats-new-query" },
      { visible: () => true, postToWebview },
    );
    expect(handled).toBe(true);
    expect(postToWebview).toHaveBeenCalledWith({ source: "amicode", kind: "whats-new-state", lastSeen: "0.3.10", tab: undefined });
  });
});

describe("Amicode: What's New", () => {
  it("registers amicode.whatsNew, which broadcasts open-whats-new", async () => {
    const ctx = { subscriptions: [] as unknown[] };
    const postToAll = vi.fn();
    const spy = vi.spyOn(vscode.commands, "registerCommand");
    registerWhatsNewCommand(ctx as unknown as vscode.ExtensionContext, { postToAll });
    const call = spy.mock.calls.find((c) => c[0] === "amicode.whatsNew");
    expect(call).toBeDefined();
    await (call![1] as () => unknown)();
    expect(postToAll).toHaveBeenCalledWith({ source: "amicode", kind: "open-whats-new" });
  });

  it("is contributed to the command palette", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
    const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === "amicode.whatsNew");
    expect(cmd?.title).toBe("Amicode: What's New");
  });

  it("the chat panel relay allowlists the kinds in both directions", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/chat_panel.ts"), "utf8");
    for (const kind of ["whats-new-query", "whats-new-seen", "whats-new-state", "open-whats-new"]) {
      expect(src.split(`d.kind === "${kind}"`).length - 1, kind).toBeGreaterThanOrEqual(2);
    }
  });
});
