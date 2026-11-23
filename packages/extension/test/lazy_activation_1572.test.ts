// #1572 — the extension must not activate (and so must not spawn/adopt the
// opencode server) on every window open. `onStartupFinished` activated it
// unconditionally; activation is now lazy: it happens on first use (any
// contributed command, or opening the AMICODE view), after which activate()
// runs exactly as before — server bring-up, chat.autoOpen, and the stale-port /
// handshake handling are unchanged.
//
// These tests pin the manifest contract that makes lazy activation safe:
//   1. no eager activation event (onStartupFinished / "*");
//   2. every command and view still activates the extension on first use;
//   3. a restored fleet-client window's amico-host:/ folder still activates the
//      extension (its FileSystemProvider is registered in activate()).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_SCHEME } from "../src/fleet_host_fs/mount_policy";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const events: string[] = pkg.activationEvents ?? [];

describe("#1572 — lazy activation (no eager server spawn on window open)", () => {
  it("declares no eager activation event", () => {
    expect(events).not.toContain("onStartupFinished");
    expect(events).not.toContain("*");
  });

  // VS Code >= 1.74 generates `onCommand:<id>` for every contributed command
  // and `onView:<id>` for every contributed view, so dropping the eager event
  // leaves every command and view able to activate the extension on first use.
  it("targets a VS Code engine with implicit onCommand/onView activation (>= 1.74)", () => {
    const m = /(\d+)\.(\d+)/.exec(String(pkg.engines?.vscode ?? ""));
    expect(m).not.toBeNull();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    expect(major > 1 || (major === 1 && minor >= 74)).toBe(true);
  });

  it("every menu and keybinding entry targets a contributed command (implicitly activatable)", () => {
    const contributed = new Set((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
    const menuEntries = Object.values(pkg.contributes.menus ?? {}).flat() as { command?: string }[];
    const keybindings = (pkg.contributes.keybindings ?? []) as { command: string }[];
    const targets = [...menuEntries.map((m) => m.command), ...keybindings.map((k) => k.command)].filter(
      (c): c is string => !!c,
    );
    expect(targets.filter((c) => !contributed.has(c))).toEqual([]);
  });

  it("no command, menu, or keybinding is gated on a context key only activate() could set", () => {
    // A `when`/`enablement` clause on an extension-set key would stay false
    // until activation, hiding the very command that should trigger it.
    const src = tsSources(resolve(__dirname, "..", "src"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const setKeys = [...src.matchAll(/["']setContext["']\s*,\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const clauses = [
      ...(pkg.contributes.commands as { enablement?: string }[]).map((c) => c.enablement),
      ...(Object.values(pkg.contributes.menus ?? {}).flat() as { when?: string }[]).map((m) => m.when),
      ...((pkg.contributes.keybindings ?? []) as { when?: string }[]).map((k) => k.when),
    ].filter((w): w is string => !!w);
    for (const key of setKeys) {
      for (const clause of clauses) expect(clause).not.toContain(key);
    }
  });

  // A fleet-client window adds an `amico-host:/` workspace folder (#1267).
  // On reload, VS Code must activate the extension to resolve that folder —
  // previously onStartupFinished covered it (late); now it needs an explicit
  // onFileSystem event, since that one is never generated implicitly.
  it("activates on the amico-host file system so a restored host folder resolves", () => {
    expect(events).toContain(`onFileSystem:${HOST_SCHEME}`);
  });
});

function tsSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsSources(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}
