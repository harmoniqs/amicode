// Where does a local solve's orchestrator live? (#2045 E)
//
//   unit  — a transient user service `amico-run-<runId>.service` outside the engine's cgroup,
//           so an engine restart / crash / OOM kill does not take the solve with it.
//   none  — in this process (today's behaviour). Reported as NOT protected.
//
// The ladder: AMICO_RUN_PLACEMENT = none|unit|auto (default auto) → on Linux, probe that the
// user service manager works AND lingering is on → else `none` with one stderr line.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";

export type PlacementMode = "none" | "unit";

export interface PlacementChoice {
  mode: PlacementMode;
  /** set when `none` was chosen because protection was wanted but unavailable */
  warning?: string;
}

export const UNPROTECTED_WARNING =
  "amico-run: NOT protected from engine restarts (no user service manager / lingering off); running in-process";

export function unitPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_RUN_UNIT_PREFIX;
  return v && /^amico-run-[a-z0-9-]*$/.test(v) ? v : "amico-run-";
}

/** Env for the systemd-run / setsid subprocess: the user bus must be discoverable. */
export function managerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.BUN_INSPECT;
  if (!out.XDG_RUNTIME_DIR) {
    const dir = `/run/user/${process.getuid?.() ?? 0}`;
    if (existsSync(dir)) out.XDG_RUNTIME_DIR = dir;
  }
  return out;
}

let probeCache: { ok: boolean; reason: string } | undefined;

/** Cached per process. Succeeds only when `systemd-run --user` really starts a unit AND the user
 *  has lingering enabled (otherwise the unit dies when the last login session ends). */
export function probeUserUnits(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason: string } {
  if (probeCache) return probeCache;
  const result = (ok: boolean, reason: string): { ok: boolean; reason: string } => (probeCache = { ok, reason });
  if (process.platform !== "linux") return result(false, `unit placement is Linux-only (${process.platform})`);
  const menv = managerEnv(env);
  const probe = spawnSync(
    "systemd-run",
    ["--user", "--quiet", "--collect", "--wait", `--unit=${unitPrefix(env)}probe-${randomBytes(3).toString("hex")}`, "/bin/true"],
    { env: menv, stdio: "ignore", timeout: 20000 },
  );
  if (probe.error || probe.status !== 0) return result(false, "systemd-run --user cannot start a unit");
  const linger = spawnSync("loginctl", ["show-user", userInfo().username, "-p", "Linger", "--value"], {
    env: menv,
    encoding: "utf8",
    timeout: 10000,
  });
  if (linger.error || linger.status !== 0 || linger.stdout.trim() !== "yes") return result(false, "lingering is off");
  return result(true, "ok");
}

export function choosePlacement(env: NodeJS.ProcessEnv = process.env): PlacementChoice {
  const want = (env.AMICO_RUN_PLACEMENT ?? "auto").trim().toLowerCase();
  if (want === "none") return { mode: "none" };
  // `setsid-test` is the test seam: a real detached spawn of the adopt command (see setsidPlacer).
  if (want === "setsid-test") return { mode: "unit" };
  const probe = probeUserUnits(env);
  if (probe.ok) return { mode: "unit" };
  return { mode: "none", warning: UNPROTECTED_WARNING };
}

/** Env passed to a placed orchestrator: an ALLOWLIST, never the whole environment — a systemd
 *  manager must not become a store for the invoking shell's credentials. */
export function allowlistEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const exact = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "LD_LIBRARY_PATH"]);
  const prefixes = ["JULIA_", "AMICO_", "AMICODE_", "XDG_", "SSL_CERT_"];
  const secretish = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/i;
  const never = new Set(["AMICODE_ENGINE_INSPECT", "BUN_INSPECT"]);
  const pass = new Set(
    (env.AMICO_RUN_PASS_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || never.has(k) || v.includes("\n") || v.includes("\0")) continue;
    const byName = exact.has(k) || (prefixes.some((p) => k.startsWith(p)) && !secretish.test(k));
    if (byName || pass.has(k)) out[k] = v;
  }
  return out;
}

export interface PlacedRun {
  /** systemd unit name, or null (the test seam places without a unit) */
  unit: string | null;
  /** best-effort liveness of the placed orchestrator, independent of run.lock */
  alive(): boolean;
  /** request the orchestrator to stop (it aborts the run); resolves when the request is made */
  stop(): Promise<void>;
}

export interface PlaceArgs {
  runId: string;
  runDir: string;
  env: NodeJS.ProcessEnv;
}

export interface Placer {
  place(args: PlaceArgs): PlacedRun | string; // string = failure reason
}

/** The command that re-enters this very program in adopt mode. */
export function adoptCommand(runDir: string, unit: string | null): { exe: string; args: string[] } | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    return undefined;
  }
  return { exe: process.execPath, args: [real, "run", "--adopt", runDir, ...(unit ? ["--unit", unit] : [])] };
}

export const systemdPlacer: Placer = {
  place({ runId, runDir, env }) {
    const unit = `${unitPrefix(env)}${runId}.service`;
    const cmd = adoptCommand(runDir, unit);
    if (!cmd) return "cannot resolve the amico entry point";
    const setenv = Object.entries(allowlistEnv(env)).map(([k, v]) => `--setenv=${k}=${v}`);
    const menv = managerEnv(env);
    const r = spawnSync(
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        "--property=Type=exec",
        "--property=TimeoutStopSec=30",
        // SIGTERM only the orchestrator on stop: it aborts the run and kills Julia's group itself
        // (marking the run `aborted`); control-group kill would race a bare TERM into Julia first.
        "--property=KillMode=mixed",
        `--working-directory=${runDir}`,
        ...setenv,
        cmd.exe,
        ...cmd.args,
      ],
      { env: menv, encoding: "utf8", timeout: 30000 },
    );
    if (r.error || r.status !== 0) return `systemd-run failed: ${r.error?.message ?? r.stderr.trim()}`;
    return {
      unit,
      alive() {
        const s = spawnSync("systemctl", ["--user", "is-active", unit], { env: menv, encoding: "utf8", timeout: 10000 });
        const state = s.stdout.trim();
        return state === "active" || state === "activating" || state === "deactivating";
      },
      async stop() {
        await runQuiet("systemctl", ["--user", "stop", unit], menv);
      },
    };
  },
};

/** TEST SEAM (AMICO_RUN_PLACEMENT=setsid-test): a real detached spawn of the adopt command in
 *  its own session with the same env allowlist — proves detach / survive-the-client semantics
 *  without touching the user service manager. Protection is `none` (no unit, same cgroup). */
export const setsidPlacer: Placer = {
  place({ runDir, env }) {
    const cmd = adoptCommand(runDir, null);
    if (!cmd) return "cannot resolve the amico entry point";
    const child = spawn(cmd.exe, cmd.args, {
      cwd: runDir,
      env: allowlistEnv(env),
      detached: true,
      stdio: "ignore",
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", () => {
      exited = true;
    });
    child.unref();
    return {
      unit: null,
      alive: () => !exited,
      async stop() {
        if (!exited) child.kill("SIGTERM");
      },
    };
  },
};

export function placerFor(env: NodeJS.ProcessEnv = process.env): Placer {
  return (env.AMICO_RUN_PLACEMENT ?? "").trim().toLowerCase() === "setsid-test" ? setsidPlacer : systemdPlacer;
}

export function runQuiet(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveP) => {
    const c = spawn(exe, args, { env, stdio: "ignore" });
    c.on("error", () => resolveP(127));
    c.on("close", (code) => resolveP(code ?? 1));
  });
}
