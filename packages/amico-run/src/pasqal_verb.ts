// packages/amico-run/src/pasqal_verb.ts — the `amico pasqal` verb (issue #160):
// the agent-driven device path. Two subcommands:
//
//   amico pasqal devices
//       → the device list the Pasqal Connection exposes, each tagged free /
//         non-free, read ONLY from the non-secret status cache. AC4 states
//         (not-connected / expired / no-devices / stale-devices) surface as a
//         distinct, actionable block and a non-zero exit — never a silent fail.
//
//   amico pasqal submit --device <id> --artifact <pulse.toml> [--confirm <hash>] [--dry-run]
//       → route ONE solve's pulse to ONE explicitly chosen Device. Selection is
//         per-submission and explicit: --device is mandatory, nothing is ever
//         auto-selected. A NON-FREE (paid emulator / real QPU) target is
//         REFUSED unless --confirm matches the submission digest (AC5) — an
//         authorization error is never a substitute for asking, and there is no
//         auto-fallback to a paid target. Free/emulator (EMU_FREE) runs skip
//         the paid-confirm but are still per-solve explicit.
//
// SECURITY (AC3): this verb reads STATUS ONLY from the connections cache and
// NEVER opens the token file. Submission flows through the `amico-pasqal`
// launcher spawned as a SUBPROCESS — the launcher (packages/amico-run,
// pasqal_launch.ts, tested) is the one place the token is read and injected
// into the child env; this verb's process never touches the secret, and no
// token appears in the digest, the JSON output, or the launcher argv.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opsDir } from "./paths.js";
import {
  pulseSha256,
  readDevicePathStatus,
  submissionDigest,
  type ClassifiedDevice,
  type DevicePathStatus,
} from "./pasqal_devices.js";
import type { VerbResult } from "./verbs.js";

/** Spawn seam (injected by tests): run the amico-pasqal launcher with `argv`
 *  and resolve its exit code. The default spawns the real launcher bin. */
export type LauncherSpawn = (argv: string[]) => Promise<{ code: number }>;

export interface PasqalVerbCtx {
  env?: NodeJS.ProcessEnv;
  now?: number;
  spawn?: LauncherSpawn;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

// ── connector + launcher resolution ───────────────────────────────────────────

/** $AMICODE_OPS_DIR → ~/.amico/amicode — the SAME resolution the fork's
 *  amicodeOpsDir() and the extension use, so the packaged connector is found
 *  where it is staged. */
function amicodeOpsDir(env: NodeJS.ProcessEnv): string {
  const v = env.AMICODE_OPS_DIR;
  if (v && v.trim() !== "") return v;
  return opsDir();
}

/** $AMICO_PASQAL_CONNECTOR overrides; default is the staged submit connector. */
function connectorScript(env: NodeJS.ProcessEnv): string {
  const v = env.AMICO_PASQAL_CONNECTOR;
  if (v && v.trim() !== "") return v;
  return join(amicodeOpsDir(env), "scripts", "pasqal-connector", "submit.py");
}

/** $AMICO_PASQAL_LAUNCHER overrides; default resolves the bundled launcher
 *  beside this module (launcher/amico-pasqal, sibling of src/ and dist/),
 *  falling back to the bin name on PATH. */
function launcherBin(env: NodeJS.ProcessEnv): string {
  const v = env.AMICO_PASQAL_LAUNCHER;
  if (v && v.trim() !== "") return v;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(here, "..", "launcher", "amico-pasqal");
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through to PATH */
  }
  return "amico-pasqal";
}

const defaultSpawn: (bin: string) => LauncherSpawn = (bin) => (argv) =>
  new Promise<{ code: number }>((resolveP) => {
    const child = spawn(bin, argv, { stdio: "inherit" });
    child.on("error", () => resolveP({ code: 64 }));
    child.on("close", (code, signal) => resolveP({ code: code ?? (signal ? 128 : 1) }));
  });

// ── result shaping ────────────────────────────────────────────────────────────

function blocked(status: DevicePathStatus): VerbResult {
  return {
    json: {
      verb: "pasqal",
      ok: false,
      connection_state: status.connection_state,
      block: status.block,
      devices: status.devices,
    },
    code: 64,
  };
}

// ── devices ───────────────────────────────────────────────────────────────────

function devices(ctx: PasqalVerbCtx): VerbResult {
  const env = ctx.env ?? process.env;
  const status = readDevicePathStatus({ env, now: ctx.now });
  if (!status.ok) return blocked(status);
  return {
    json: {
      verb: "pasqal",
      subcommand: "devices",
      ok: true,
      connection_state: status.connection_state,
      identity: status.identity,
      validated_at: status.validated_at,
      devices: status.devices,
    },
    code: 0,
  };
}

// ── submit ────────────────────────────────────────────────────────────────────

function usageError(error: string): VerbResult {
  return {
    json: {
      verb: "pasqal",
      subcommand: "submit",
      ok: false,
      error,
      usage: "amico pasqal submit --device <id> --artifact <pulse.toml> [--confirm <hash>] [--dry-run]",
    },
    code: 64,
  };
}

async function submit(argv: string[], ctx: PasqalVerbCtx): Promise<VerbResult> {
  const env = ctx.env ?? process.env;

  // Explicit per-solve selection: both flags are mandatory (never auto-select).
  const deviceId = flagValue(argv, "--device");
  const pulse = flagValue(argv, "--artifact");
  if (!deviceId) return usageError("--device <id> is required — device selection is per-submission and explicit");
  if (!pulse) return usageError("--artifact <pulse.toml> is required");
  const dryRun = argv.includes("--dry-run");
  const confirm = flagValue(argv, "--confirm");

  // AC4: the connection must be usable BEFORE anything else. A blocked state
  // disables the path with its distinct, actionable message — never a spawn.
  const status = readDevicePathStatus({ env, now: ctx.now });
  if (!status.ok) return blocked(status);

  // Resolve the chosen device in the connection's list (case-insensitive on id
  // or name). Not present → refuse, listing what IS available.
  const wanted = deviceId.trim().toUpperCase();
  const device: ClassifiedDevice | undefined = status.devices.find(
    (d) => d.id.toUpperCase() === wanted || d.name?.toUpperCase() === wanted,
  );
  if (!device) {
    return {
      json: {
        verb: "pasqal",
        subcommand: "submit",
        ok: false,
        error: `device "${deviceId}" is not exposed by the Pasqal connection`,
        available: status.devices.map((d) => d.id),
      },
      code: 64,
    };
  }

  if (!existsSync(pulse)) return usageError(`pulse file not found: ${pulse}`);

  // The confirm gate binds to WHAT is submitted (device + pulse content +
  // project) — a token/password is never any part of it.
  const digest = submissionDigest({
    deviceId: device.id,
    deviceName: device.name,
    tier: device.tier,
    pulseSha256: pulseSha256(pulse),
    projectId: status.identity,
  });

  // AC5: a NON-FREE target REQUIRES an explicit, matching --confirm. This is
  // checked BEFORE --dry-run and BEFORE any spawn — nothing (not --dry-run, not
  // a wrong confirm) can bypass it, and there is no fallback to a paid target.
  if (device.tier === "non-free" && confirm !== digest.confirm) {
    return {
      json: {
        verb: "pasqal",
        subcommand: "submit",
        ok: false,
        confirm_required: true,
        device: device.id,
        tier: device.tier,
        digest,
        error:
          confirm === undefined
            ? `submitting to non-free device ${device.id} requires explicit confirmation — re-run with --confirm ${digest.confirm}`
            : `--confirm did not match the submission digest for ${device.id} — re-run with --confirm ${digest.confirm}`,
      },
      code: 64,
    };
  }

  // Build the launcher argv: `<connector.py> <pulse> --device <id> [--yes]`.
  // --yes is appended ONLY for a confirmed non-free target (the connector's
  // own defense-in-depth gate). No secret ever rides this argv.
  const connector = connectorScript(env);
  const launcherArgv = [connector, pulse, "--device", device.id];
  if (device.tier === "non-free") launcherArgv.push("--yes");

  if (dryRun) {
    return {
      json: {
        verb: "pasqal",
        subcommand: "submit",
        ok: true,
        dry_run: true,
        device: device.id,
        tier: device.tier,
        launcher_argv: launcherArgv,
      },
      code: 0,
    };
  }

  const runSpawn = ctx.spawn ?? defaultSpawn(launcherBin(env));
  const { code } = await runSpawn(launcherArgv);
  return {
    json: {
      verb: "pasqal",
      subcommand: "submit",
      ok: code === 0,
      device: device.id,
      tier: device.tier,
      exit_code: code,
    },
    code,
  };
}

// ── dispatch ───────────────────────────────────────────────────────────────────

/** The `pasqal` verb body. `ctx` is injected by tests (env/clock/spawn); the
 *  CLI wrapper (verbs.ts) calls it with defaults. */
export async function pasqalVerb(argv: string[], ctx: PasqalVerbCtx = {}): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "devices") return devices(ctx);
  if (sub === "submit") return submit(rest, ctx);
  return {
    json: {
      verb: "pasqal",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico pasqal devices  |  amico pasqal submit --device <id> --artifact <pulse.toml> [--confirm <hash>]",
    },
    code: 64,
  };
}
