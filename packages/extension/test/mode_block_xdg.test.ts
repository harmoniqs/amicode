// #1015: the context plugin reads the staged mode registry from the SAME
// config dir the extension stages to — $XDG_CONFIG_HOME/opencode (Flatpak VS
// Code overrides XDG_CONFIG_HOME), else ~/.config/opencode.
import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { deployedModesRoot } from "../opencode-plugin/mode_block";
import { opencodeGlobalConfigRoot } from "../src/mode_cards";

describe("deployedModesRoot honours XDG_CONFIG_HOME (#1015)", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  });

  it("reads <XDG_CONFIG_HOME>/opencode/modes when set", () => {
    process.env.XDG_CONFIG_HOME = "/var/app/flatpak/config";
    expect(deployedModesRoot()).toBe(join("/var/app/flatpak/config", "opencode", "modes"));
  });

  it("falls back to ~/.config/opencode/modes when unset or empty", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(deployedModesRoot()).toBe(join(homedir(), ".config", "opencode", "modes"));
    process.env.XDG_CONFIG_HOME = "";
    expect(deployedModesRoot()).toBe(join(homedir(), ".config", "opencode", "modes"));
  });

  it("mirrors where the extension stages bundles", () => {
    process.env.XDG_CONFIG_HOME = "/var/app/flatpak/config";
    expect(deployedModesRoot()).toBe(join(opencodeGlobalConfigRoot(), "modes"));
  });
});
