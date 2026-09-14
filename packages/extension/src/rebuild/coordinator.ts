/**
 * Rebuild deployment — the atomic-swap deployment step (#1016, #1021).
 *
 * The Developer Tools bridge handler (chat_bridge.ts) calls `deployBuild`
 * after building the extension from the committed overlay. Host classification
 * (#1023) and dependency pre-flight (#1020) run in the bridge handler directly
 * via host_matrix + dependency_resolver.
 *
 * deployBuild flow:
 * 1. Back up the installed extension (#1021)
 * 2. Stage the build output (#1021)
 * 3. Codesign the binary on macOS (best-effort)
 * 4. Write a pending-swap marker, atomic swap, commit (#1021)
 * 5. No settings.json writes (#1022)
 */

import * as path from "node:path";

import { gateKeeperClear } from "./host_matrix";
import { stageExtensionBuild, createBackup, atomicSwap, pruneBackups, writePendingMarker, commitSwap } from "./atomic_adoption";
import type { ExecFn, ExecResult } from "./exec_types";
import type { RebuildError } from "../rebuild_errors";

// ── Types ──

export interface RebuildCoordinatorResult {
  ok: boolean;
  error?: RebuildError;
  rolledBack?: boolean;
}

// ── Default shell exec ──

function defaultExec(cmd: string, cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { exec } = require("node:child_process");
    exec(cmd, { cwd, timeout: 300_000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) resolve({ ok: false, stdout: "", error: stderr?.trim() || err.message });
      else resolve({ ok: true, stdout: stdout?.toString() ?? "" });
    });
  });
}

// ── Deployment step (called after build completes) ──

export interface DeployOpts {
  extensionPath: string;      // installed extension dir
  buildDir: string;           // packages/extension in the amicode repo
  binaryPath?: string;        // resolved freshly-built binary (codesign + copy source)
  platformKey?: string;       // e.g. "darwin-arm64" — vendor/opencode/<key>/opencode
  overrideActive?: boolean;   // an opencodeBinary config override is set → runtime
                              // resolves the binary via the override, so copying it
                              // into the installed vendor tree is dead work (skip it)
  exec?: ExecFn;
  onPhase?: (phase: string, detail?: string) => void;
}

export async function deployBuild(opts: DeployOpts): Promise<RebuildCoordinatorResult> {
  const exec = opts.exec ?? defaultExec;
  const onPhase = opts.onPhase ?? (() => {});

  // ── Backup the installed extension (#1021) ──
  onPhase("backup", "Backing up installed extension...");
  let backupDir: string;
  try {
    backupDir = await createBackup(opts.extensionPath);
    pruneBackups(path.dirname(opts.extensionPath), 3);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "BACKUP_FAILED",
        message: "Could not back up the installed extension",
        fix: [
          "Check disk space and permissions on the VS Code extensions directory.",
          `Detail: ${e instanceof Error ? e.message : String(e)}`,
        ],
      },
    };
  }

  // ── Stage the build output (#1021) ──
  // Parity with the shell rebuild scripts (#1135): when this is a plain install
  // (no opencodeBinary override), stage the freshly built binary too, so the
  // atomic swap updates dist AND the engine together — otherwise the installed
  // extension self-discovers a STALE vendor binary against fresh dist.
  // The built binary is opts.binaryPath when given, else derived from the
  // buildDir's vendor tree (what build:binary writes).
  const builtBinary = opts.binaryPath
    ?? (opts.platformKey
      ? path.join(opts.buildDir, "vendor", "opencode", opts.platformKey, "opencode")
      : undefined);
  const copyBinary = !!builtBinary && !!opts.platformKey && !opts.overrideActive;
  onPhase("stage", "Staging build output...");
  let stagingDir: string;
  try {
    stagingDir = stageExtensionBuild(opts.extensionPath, opts.buildDir, {
      binarySource: copyBinary ? builtBinary : undefined,
      platformKey: copyBinary ? opts.platformKey : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "STAGE_FAILED",
        message: "Could not stage build output",
        fix: [`Detail: ${e instanceof Error ? e.message : String(e)}`],
      },
    };
  }

  // ── Codesign on macOS (best-effort) ──
  if (opts.binaryPath && process.platform === "darwin") {
    onPhase("codesign", "Codesigning binary...");
    await gateKeeperClear(opts.binaryPath, exec);
  }

  // ── Write pending-swap marker (#1021) ──
  const markerDir = path.join(process.env.HOME ?? "~", ".amico", "rebuild-backups");
  const markerPath = path.join(markerDir, "pending.json");
  writePendingMarker(markerPath, {
    backup_path: backupDir,
    target_path: opts.extensionPath,
    timestamp: new Date().toISOString(),
    swap_state: "pending",
  });

  // ── Atomic swap (#1021) ──
  onPhase("swap", "Installing build...");
  const swapResult = await atomicSwap({
    extensionDir: opts.extensionPath,
    stagingDir,
    backupDir,
    platformKey: copyBinary ? opts.platformKey : undefined,
  });

  if (!swapResult.ok) {
    return {
      ok: false,
      rolledBack: swapResult.rolledBack,
      error: {
        code: "SWAP_FAILED",
        message: swapResult.error ?? "Atomic swap failed",
        fix: [
          swapResult.rolledBack
            ? "The previous version has been restored automatically."
            : `Manual recovery: copy ${backupDir} back to ${opts.extensionPath}`,
        ],
      },
    };
  }

  // ── Commit swap (delete pending marker) ──
  commitSwap(markerPath);

  // No settings.json writes (#1022) — the extension discovers paths at
  // runtime from context.extensionPath.

  return { ok: true };
}
