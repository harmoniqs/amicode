import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// ── Helpers ──

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-adopt-"));
  return dir;
}

function makeExtensionDir(root: string): string {
  const extDir = join(root, "harmoniqs.amicode-0.1.0");
  const distDir = join(extDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// old extension");
  writeFileSync(join(distDir, "extension.js.map"), "// old map");
  mkdirSync(join(distDir, "app"), { recursive: true });
  writeFileSync(join(distDir, "app", "index.html"), "<html>old</html>");
  writeFileSync(join(extDir, "package.json"), '{"name":"amicode","version":"0.1.0"}');
  return extDir;
}

function makeStagingDir(root: string): string {
  const stagingDir = join(root, ".amicode-staging-test");
  const distDir = join(stagingDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// new extension");
  writeFileSync(join(distDir, "extension.js.map"), "// new map");
  mkdirSync(join(distDir, "app"), { recursive: true });
  writeFileSync(join(distDir, "app", "index.html"), "<html>new</html>");
  writeFileSync(join(stagingDir, "package.json"), '{"name":"amicode","version":"0.2.0"}');
  return stagingDir;
}

// ── Tests ──

describe("atomic_adoption (#1021)", () => {
  let cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  async function importModule() {
    return import("../src/rebuild/atomic_adoption");
  }

  // ════════════════════════════════════════════════════════════════════════
  // createBackup
  // ════════════════════════════════════════════════════════════════════════
  describe("createBackup", () => {
    it("creates a timestamped backup sibling of the extension dir", async () => {
      const { createBackup } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtensionDir(root);

      const backupPath = await createBackup(extDir);
      expect(existsSync(backupPath)).toBe(true);
      expect(dirname(backupPath)).toBe(dirname(extDir)); // same parent = same filesystem
      expect(existsSync(join(backupPath, "dist", "extension.js"))).toBe(true);
      expect(readFileSync(join(backupPath, "dist", "extension.js"), "utf8")).toBe("// old extension");
    });

    it("prunes excess backups beyond 3", async () => {
      const { createBackup, pruneBackups } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtensionDir(root);

      // Create 4 backups
      const backups: string[] = [];
      for (let i = 0; i < 4; i++) {
        backups.push(await createBackup(extDir));
      }

      pruneBackups(dirname(extDir), 3);

      // Count remaining backup dirs
      const { readdirSync } = require("fs");
      const remaining = readdirSync(dirname(extDir)).filter((f: string) =>
        f.startsWith(".amicode-backup-"),
      );
      expect(remaining.length).toBeLessThanOrEqual(3);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // atomicSwap
  // ════════════════════════════════════════════════════════════════════════
  describe("atomicSwap", () => {
    it("swaps dist contents atomically via rename", async () => {
      const { atomicSwap } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtensionDir(root);
      const stagingDir = makeStagingDir(root);

      const result = await atomicSwap({
        extensionDir: extDir,
        stagingDir,
        backupDir: join(root, ".amicode-backup-test"),
      });
      expect(result.ok).toBe(true);
      // New content should be in place
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// new extension");
      expect(readFileSync(join(extDir, "dist", "app", "index.html"), "utf8")).toBe("<html>new</html>");
    });

    it("rolls back on swap failure", async () => {
      const { atomicSwap, createBackup } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtensionDir(root);
      const backupDir = await createBackup(extDir);

      // Create an invalid staging dir (no dist)
      const badStaging = join(root, ".amicode-staging-bad");
      mkdirSync(badStaging, { recursive: true });

      const result = await atomicSwap({
        extensionDir: extDir,
        stagingDir: badStaging,
        backupDir,
      });
      // Should have rolled back — original content restored
      expect(existsSync(join(extDir, "dist", "extension.js"))).toBe(true);
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// old extension");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // pendingSwapMarker
  // ════════════════════════════════════════════════════════════════════════
  describe("pendingSwapMarker", () => {
    it("writes and reads a pending-swap marker", async () => {
      const { writePendingMarker, readPendingMarker } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const markerDir = join(root, ".amico", "rebuild-backups");
      mkdirSync(markerDir, { recursive: true });
      const markerPath = join(markerDir, "pending.json");

      writePendingMarker(markerPath, {
        backup_path: "/backup",
        target_path: "/target",
        timestamp: "2026-09-12T00:00:00Z",
        swap_state: "pending",
      });
      expect(existsSync(markerPath)).toBe(true);

      const marker = readPendingMarker(markerPath);
      expect(marker).toBeDefined();
      expect(marker!.swap_state).toBe("pending");
      expect(marker!.backup_path).toBe("/backup");
    });

    it("returns undefined for missing marker", async () => {
      const { readPendingMarker } = await importModule();
      const marker = readPendingMarker("/nonexistent/pending.json");
      expect(marker).toBeUndefined();
    });

    it("deletes the marker on commit", async () => {
      const { writePendingMarker, commitSwap } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const markerDir = join(root, ".amico", "rebuild-backups");
      mkdirSync(markerDir, { recursive: true });
      const markerPath = join(markerDir, "pending.json");

      writePendingMarker(markerPath, {
        backup_path: "/backup",
        target_path: "/target",
        timestamp: "2026-09-12T00:00:00Z",
        swap_state: "pending",
      });
      commitSwap(markerPath);
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // stageExtensionBuild
  // ════════════════════════════════════════════════════════════════════════
  describe("stageExtensionBuild", () => {
    it("stages build output as a sibling of the extension dir", async () => {
      const { stageExtensionBuild } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtensionDir(root);

      // Create a mock build output
      const buildDir = join(root, "amicode-repo", "packages", "extension");
      const buildDist = join(buildDir, "dist");
      mkdirSync(buildDist, { recursive: true });
      writeFileSync(join(buildDist, "extension.js"), "// built");

      const stagingDir = stageExtensionBuild(extDir, buildDir);
      expect(existsSync(stagingDir)).toBe(true);
      expect(dirname(stagingDir)).toBe(dirname(extDir)); // same filesystem
      expect(existsSync(join(stagingDir, "dist", "extension.js"))).toBe(true);
    });
  });
});
