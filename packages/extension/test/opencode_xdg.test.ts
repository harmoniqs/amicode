import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { opencodeConfigDir, opencodeDataDir } from "../src/opencode_xdg";

const FAKE_HOME = "/home/testuser";

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opencodeConfigDir", () => {
  it("returns $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    expect(opencodeConfigDir()).toBe(path.join("/custom/config", "opencode"));
    delete process.env.XDG_CONFIG_HOME;
  });

  it("returns ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(opencodeConfigDir()).toBe(path.join(FAKE_HOME, ".config", "opencode"));
  });
});

describe("opencodeDataDir", () => {
  it("returns $XDG_DATA_HOME/opencode when XDG_DATA_HOME is set", () => {
    process.env.XDG_DATA_HOME = "/custom/data";
    expect(opencodeDataDir()).toBe(path.join("/custom/data", "opencode"));
    delete process.env.XDG_DATA_HOME;
  });

  it("returns ~/.local/share/opencode when XDG_DATA_HOME is unset", () => {
    delete process.env.XDG_DATA_HOME;
    expect(opencodeDataDir()).toBe(
      path.join(FAKE_HOME, ".local", "share", "opencode")
    );
  });
});
