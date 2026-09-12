/**
 * Rebuild coordinator — the shared orchestration function (#1016)
 *
 * Both the Developer Tools bridge handler (chat_bridge.ts) and the
 * shell scripts (rebuild_amicode_*.sh) call this. Every module from
 * #1018–#1023 is wired through here.
 *
 * Flow:
 * 1. classifyHost + detectWSLVersion → reject unsupported hosts (#1023)
 * 2. checkDependencies + isBlocked → refuse if hard prereqs missing (#1020)
 * 3. Session DB backup
 * 4. Main: rebuildFromMain (git pull + release download) / Local: fork build (#1018)
 * 5. pnpm install + amicode build + app bundle build
 * 6. stageExtensionBuild + atomicSwap (#1021)
 * 7. No settings.json writes (#1022)
 */

import * as path from "node:path";
import * as fs from "node:fs";

import { classifyHost, detectWSLVersion, gateKeeperClear } from "./host_matrix";
import { checkDependencies, isBlocked, buildProvisionPlan } from "./dependency_resolver";
import { rebuildFromMain, type ExecFn, type ExecResult } from "./main_source_resolver";
import { stageExtensionBuild, createBackup, atomicSwap, pruneBackups, writePendingMarker, commitSwap } from "./atomic_adoption";
import { classifyError, type RebuildError } from "../rebuild_errors";

// ── Types ──

export type RebuildMode = "main" | "local";

export interface RebuildCoordinatorOpts {
  mode: RebuildMode;
  amicodePath: string;
  opencodePath?: string;           // required for local mode only
  extensionPath: string;           // installed extension dir (context.extensionPath)
  exec?: ExecFn;                   // injectable for tests
  onPhase?: (phase: string, detail?: string) => void;
  platform?: string;               // override for tests
  arch?: string;                   // override for tests
}

export interface RebuildCoordinatorResult {
  ok: boolean;
  error?: RebuildError;
  binaryPath?: string;
  rolledBack?: boolean;
  pendingPromotion?: { pending: boolean; remoteHead?: string };
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

// ── Coordinator ──

export async function runRebuild(opts: RebuildCoordinatorOpts): Promise<RebuildCoordinatorResult> {
  const exec = opts.exec ?? defaultExec;
  const onPhase = opts.onPhase ?? (() => {});
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  // ── Step 1: Host classification (#1023) ──
  onPhase("host-check", "Checking platform compatibility...");
  const host = classifyHost(platform, arch);
  if (!host.supported) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_HOST",
        message: host.rejection ?? "Unsupported platform",
        fix: platform === "win32"
          ? ["Open your project in WSL (Remote — WSL).", "Amicode will install and run inside the Linux extension host."]
          : platform === "darwin"
            ? ["This Mac needs an arm64 processor. Rosetta cannot help; the binary is arm64-native."]
            : [`Supported platforms: darwin-arm64, linux-x64, linux-arm64.`],
      },
    };
  }

  // WSL 1 detection — reject because atomic rename fails on lxfs
  if (platform === "linux") {
    const wslVersion = await detectWSLVersion(platform, exec);
    if (wslVersion === 1) {
      return {
        ok: false,
        error: {
          code: "WSL1_UNSUPPORTED",
          message: "WSL 1 is not supported — atomic file operations fail on lxfs",
          fix: [
            "Upgrade to WSL 2: wsl --set-version <distro> 2",
            "Or run natively on Linux.",
          ],
        },
      };
    }
  }

  // ── Step 2: Dependency pre-flight (#1020) ──
  onPhase("deps-check", "Checking dependencies...");
  const deps = await checkDependencies(opts.mode, exec);
  if (isBlocked(deps)) {
    const plan = buildProvisionPlan(deps);
    const blockerList = plan.blockers.map((b) => `${b.tool}: ${b.guidance}`).join("; ");
    return {
      ok: false,
      error: {
        code: "DEPS_BLOCKED",
        message: "Missing required dependencies",
        fix: plan.blockers.map((b) => `${b.tool}: ${b.guidance}`),
      },
    };
  }

  // ── Step 3: Mode-specific source resolution (#1018) ──
  let resolvedBinary = "";
  let pendingPromotion: { pending: boolean; remoteHead?: string } | undefined;

  if (opts.mode === "main") {
    onPhase("main-resolve", "Pulling main and downloading binary...");
    const mainResult = await rebuildFromMain({
      amicodePath: opts.amicodePath,
      exec,
      platformOverride: platform,
      archOverride: arch,
      onPhase,
    });
    if (!mainResult.ok) {
      return { ok: false, error: classifyError(mainResult.error ?? "Main rebuild failed") };
    }
    resolvedBinary = mainResult.binaryPath ?? "";
    pendingPromotion = mainResult.pendingPromotion;
  } else {
    // Local mode: fork build (the exec-based flow stays in chat_bridge.ts
    // because it needs the buildEnv injection and the existing bun/pnpm commands).
    // This coordinator handles the pre-flight and deployment steps around it.
    // The caller is responsible for the fork build and passing resolvedBinary.
    //
    // For the shell script path, the fork build is done by the script itself.
    // For the bridge path, the fork build is done inline in the handler.
    //
    // We return early here — the caller continues with the local build and
    // then calls deployBuild() for the deployment step.
  }

  return {
    ok: true,
    binaryPath: resolvedBinary,
    pendingPromotion,
  };
}

// ── Deployment step (called after build completes) ──

export interface DeployOpts {
  extensionPath: string;      // installed extension dir
  buildDir: string;           // packages/extension in the amicode repo
  binaryPath?: string;        // resolved binary for codesign
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
  onPhase("stage", "Staging build output...");
  let stagingDir: string;
  try {
    stagingDir = stageExtensionBuild(opts.extensionPath, opts.buildDir);
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
