import { describe, it, expect } from "vitest";

describe("host matrix (#1023)", () => {
  async function importModule() {
    return import("../src/rebuild/host_matrix");
  }

  // ════════════════════════════════════════════════════════════════════════
  // classifyHost
  // ════════════════════════════════════════════════════════════════════════
  describe("classifyHost", () => {
    it("classifies macOS arm64 as full support", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("darwin", "arm64");
      expect(result.supported).toBe(true);
      expect(result.platformKey).toBe("darwin-arm64");
    });

    it("classifies linux x64 as full support", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("linux", "x64");
      expect(result.supported).toBe(true);
      expect(result.platformKey).toBe("linux-x64");
    });

    it("classifies linux arm64 as full support", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("linux", "arm64");
      expect(result.supported).toBe(true);
      expect(result.platformKey).toBe("linux-arm64");
    });

    it("rejects native Windows with WSL guidance", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("win32", "x64");
      expect(result.supported).toBe(false);
      expect(result.rejection).toMatch(/WSL/i);
    });

    it("rejects Intel Mac (darwin-x64)", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("darwin", "x64");
      expect(result.supported).toBe(false);
      expect(result.rejection).toMatch(/Apple Silicon/i);
    });

    it("rejects unknown platform", async () => {
      const { classifyHost } = await importModule();
      const result = classifyHost("freebsd", "x64");
      expect(result.supported).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // detectWSLVersion
  // ════════════════════════════════════════════════════════════════════════
  describe("detectWSLVersion", () => {
    it("returns null on non-Linux (macOS)", async () => {
      const { detectWSLVersion } = await importModule();
      const result = await detectWSLVersion("darwin", async () => ({ ok: false, error: "not found" }));
      expect(result).toBeNull();
    });

    it("detects WSL 2 from /proc/version", async () => {
      const { detectWSLVersion } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("/proc/version")) {
          return { ok: true, stdout: "Linux version 5.15.90.1-microsoft-standard-WSL2" };
        }
        return { ok: false, error: "" };
      };
      const result = await detectWSLVersion("linux", exec);
      expect(result).toBe(2);
    });

    it("detects WSL 1 from /proc/version (no WSL2 marker)", async () => {
      const { detectWSLVersion } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("/proc/version")) {
          return { ok: true, stdout: "Linux version 4.4.0-19041-Microsoft" };
        }
        return { ok: false, error: "" };
      };
      const result = await detectWSLVersion("linux", exec);
      expect(result).toBe(1);
    });

    it("returns null on native Linux (no Microsoft in /proc/version)", async () => {
      const { detectWSLVersion } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("/proc/version")) {
          return { ok: true, stdout: "Linux version 6.5.0-44-generic (buildd@bos03-amd64-058)" };
        }
        return { ok: false, error: "" };
      };
      const result = await detectWSLVersion("linux", exec);
      expect(result).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // gateKeeperClear
  // ════════════════════════════════════════════════════════════════════════
  describe("gateKeeperClear", () => {
    it("runs xattr -d on macOS (best-effort)", async () => {
      const { gateKeeperClear } = await importModule();
      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };
      await gateKeeperClear("/path/to/opencode", exec);
      expect(commands.some((c) => c.includes("xattr"))).toBe(true);
    });

    it("does not throw on xattr failure", async () => {
      const { gateKeeperClear } = await importModule();
      const exec = async (_cmd: string) => ({ ok: false, error: "xattr: No such xattr" });
      // Should not throw
      await expect(gateKeeperClear("/path/to/opencode", exec)).resolves.not.toThrow();
    });
  });
});
