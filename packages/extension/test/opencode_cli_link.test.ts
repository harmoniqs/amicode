// stageOpencodeCliLink tests (#561): the ~/.local/bin/opencode symlink that
// makes the managed (or vendored) binary available on the user's PATH without
// them editing shell profiles. Priority: managed > vendored > skip.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  accessSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  constants,
} from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    accessSync: vi.fn(),
    readlinkSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const FAKE_HOME = "/home/testuser";
const FAKE_EXT = "/extensions/amicode";
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

const managedBin = path.join(FAKE_HOME, ".amico", "opencode", "canonical", "current", "opencode");
const vendoredBin = path.join(FAKE_EXT, "vendor", "opencode", PLATFORM_KEY, "opencode");
const symlinkPath = path.join(FAKE_HOME, ".local", "bin", "opencode");
const symlinkDir = path.join(FAKE_HOME, ".local", "bin");

beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(accessSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(readlinkSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  vi.mocked(symlinkSync).mockImplementation(() => undefined);
  vi.mocked(unlinkSync).mockImplementation(() => undefined);
  vi.mocked(mkdirSync).mockImplementation(() => undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Lazy import so mocks are in place
async function loadModule() {
  // Clear the module cache to pick up fresh mocks
  vi.resetModules();
  // Re-apply os.homedir mock after resetModules
  vi.spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
  const mod = await import("../src/opencode_cli_link");
  return mod;
}

describe("stageOpencodeCliLink", () => {
  it("creates symlink to managed binary when it exists and is executable", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // managed binary exists and is executable
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === managedBin) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if (p === managedBin && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(mkdirSync).toHaveBeenCalledWith(symlinkDir, { recursive: true });
    expect(symlinkSync).toHaveBeenCalledWith(managedBin, symlinkPath);
  });

  it("falls back to vendored binary when managed is absent", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // managed doesn't exist, vendored does
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === vendoredBin) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if (p === vendoredBin && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(mkdirSync).toHaveBeenCalledWith(symlinkDir, { recursive: true });
    expect(symlinkSync).toHaveBeenCalledWith(vendoredBin, symlinkPath);
  });

  it("does not create a symlink when neither binary exists", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // nothing exists
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(symlinkSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("is idempotent — no write when symlink already points to the correct target", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // managed binary exists
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === managedBin) return true;
      if (p === symlinkPath) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if (p === managedBin && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });
    // symlink already points correctly
    vi.mocked(readlinkSync).mockImplementation((p) => {
      if (p === symlinkPath) return managedBin;
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(unlinkSync).not.toHaveBeenCalled();
    expect(symlinkSync).not.toHaveBeenCalled();
  });

  it("updates symlink when it points to a different target", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // managed binary exists
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === managedBin) return true;
      if (p === symlinkPath) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if (p === managedBin && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });
    // symlink points elsewhere
    vi.mocked(readlinkSync).mockImplementation((p) => {
      if (p === symlinkPath) return "/old/path/opencode";
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(unlinkSync).toHaveBeenCalledWith(symlinkPath);
    expect(symlinkSync).toHaveBeenCalledWith(managedBin, symlinkPath);
  });

  it("never throws — FS errors are caught and logged", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // managed binary exists
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === managedBin) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if (p === managedBin && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });
    // symlinkSync throws (permission denied, etc.)
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    // Must not throw
    expect(() => stageOpencodeCliLink(FAKE_EXT)).not.toThrow();
  });

  it("prefers managed over vendored when both exist", async () => {
    const { stageOpencodeCliLink } = await loadModule();
    // both exist
    vi.mocked(existsSync).mockImplementation((p) => {
      if (p === managedBin) return true;
      if (p === vendoredBin) return true;
      return false;
    });
    vi.mocked(accessSync).mockImplementation((p, mode) => {
      if ((p === managedBin || p === vendoredBin) && mode === constants.X_OK) return;
      throw new Error("ENOENT");
    });

    stageOpencodeCliLink(FAKE_EXT);

    expect(symlinkSync).toHaveBeenCalledWith(managedBin, symlinkPath);
  });
});
