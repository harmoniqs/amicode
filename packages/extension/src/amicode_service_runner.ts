// ============================================================================
// amicode_service_runner — the PRODUCTION SERVICE RUNNER (#955, the hub
// cutover spec spec-20260910-080000): ONE long-lived headless process that
// spawns the vendored opencode engine (password-armed by default; UNARMED in
// the hub posture, see engineUnarmed) and serves the amicode service alongside
// it — the permanent orchestration the #822 boot probe only
// rehearses and the extension host only provides inside VS Code. The hub has
// no extension host; this is what runs there instead.
//
// Same wiring, zero drift: the service is booted through createAmicodeService
// EXACTLY as startAmicodeService wires it (engine handle + shelf distRoot +
// engine-token auth) — this module only replaces the extension-host shell
// around it (spawn, health wait, signal teardown). The mint is the SAME
// convention as every spawn site: mintServerPassword() once per boot,
// OPENCODE_SERVER_PASSWORD in the child env, serverAuthHeader() for the
// health probe (an anonymous probe would 401 and read as a timeout).
//
// FAIL-LOUD discipline: a missing engine binary, a shelf without a built app
// dist, or an engine that never becomes healthy each abort the boot with a
// NAMED reason (AmicodeServiceRunnerError.reason) and — once the engine was
// spawned — tear the child down. A silent half-boot (service up, engine dead,
// or vice versa) is the one state this runner must never produce: the hub's
// frontdoor points at this origin, and a half-boot reads as a healthy UI over
// a dead backend.
//
// FLEET DISCIPLINE (H3): the runner arms NOTHING beyond what
// createAmicodeService already does — no fleetActivation is ever passed — so
// the hub's service is the byte-identical base service (unarmed). The ops
// side (amicode-server.sh, the frontdoor re-point) is the director's slice.
//
// RUNTIME: `node bin/dist/amicode-service-runner.mjs` (bundled ESM, the
// mcp-amico.mjs convention; the CLI env surface lives in
// amicode_service_runner_cli.ts — as a module import this file is
// side-effect-free, which is what lets the vitest suite drive the same boot
// path in-process).
// ============================================================================

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createAmicodeService } from "./amicode_service";
import type { AmicodeServiceServer } from "./amicode_service/server";
import { mintServerPassword, serverAuthHeader } from "./server_auth";
import { writeHubHandshake, deleteHandshake } from "./server_handshake";

/** The named boot-abort: `reason` is the stable grep-able phrase, `message`
 *  carries the detail (engine output tail for health failures). */
export class AmicodeServiceRunnerError extends Error {
  constructor(
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "AmicodeServiceRunnerError";
  }
}

export interface AmicodeServiceRunnerOptions {
  /** The engine binary to spawn (the vendored opencode — the fetch:opencode
   *  lane's product, or an explicit AMICODE_ENGINE_BIN). Must exist. */
  engineBin: string;
  /** The app-bundle dist root for the shelf. Must contain index.html — the
   *  runner is production: it serves the REAL app or it does not boot (the
   *  NEEDS-SETUP placeholder is the extension's honest degradation, not a
   *  hub deployment shape). */
  appDistRoot: string;
  /** The service's fixed port. Default 4095 (the hub topology's engine-side
   *  surface); 0 = ephemeral. A busy fixed port falls back to ephemeral with
   *  a named log line (the startAmicodeService precedent). */
  servicePort?: number;
  /** The engine's internal port (the proxy's upstream). Default 4094; 0 =
   *  ephemeral (the probe's freePort idiom). */
  enginePort?: number;
  /** The engine's cwd. Default: a synthesized throwaway project (the
   *  probe's pattern — AGENTS.md + .opencode/opencode.json). */
  engineCwd?: string;
  /** Extra env merged OVER the host env for the spawned engine — the
   *  canonical OPENCODE_DB pin rides here (and through the host env when
   *  unset). Never credentials: the runner mints its own. */
  engineEnv?: Record<string, string | undefined>;
  /** The engine credential to arm the spawn with. Default: a fresh
   *  mintServerPassword() per boot (the per-boot mint convention). An
   *  explicit value (AMICODE_ENGINE_PASSWORD) is the hub-deployment shape:
   *  the ops layer owns the credential so the frontdoor's ?auth_token=
   *  carrier and any co-launched consumers share the engine's auth — the
   *  fork's own respawn convention (a session's spawns REUSE the value). */
  enginePassword?: string;
  /** #955 (the hub cutover's unarmed posture): spawn the engine WITHOUT
   *  OPENCODE_SERVER_PASSWORD — the anonymous engine the fork hub deploys
   *  (the 2026-08-07 incident record: "canonical serves anonymous 200"; the
   *  SSH mesh is the security boundary). The service's app-proxy forwards
   *  client requests verbatim (no header rewriting), so an armed engine
   *  would 401 the fleet panel's anonymous calls. Expected ALONGSIDE
   *  AMICODE_SERVICE_AUTH=open — the service's authMode resolves
   *  independently (its own env passthrough in createAmicodeService); the
   *  pair is the hub posture. Wins over enginePassword when both are given.
   *  Default: armed (the per-boot mint convention) — zero change for every
   *  existing caller. */
  engineUnarmed?: boolean;
  /** Engine health-wait budget. Default 30_000 (the ServerManager budget). */
  healthTimeoutMs?: number;
  /** PID file path for stale-engine cleanup on restart. When set, the runner:
   *  (1) reads any existing PID file on boot and kills a stale opencode engine
   *      (best-effort — missing file, dead PID, or non-opencode PID is silently
   *      skipped); (2) writes the new engine child's PID after spawn; (3)
   *  removes the file on shutdown. Default: undefined (no PID file — backward
   *  compatible). */
  pidFile?: string;
  /** Handshake file path for extension adoption (#1579). When set, the runner
   *  writes the handshake record after the engine is healthy AND the service is
   *  up, and removes it on shutdown (BEFORE killing the engine — order matters:
   *  the extension must not read a handshake for a dying engine). The handshake
   *  carries the UNARMED_PASSWORD sentinel (the hub engine is unarmed, so the
   *  password challenge is vacuously true). Default: undefined (no handshake —
   *  backward compatible, same pattern as pidFile). */
  handshakePath?: string;
  /** Log sink (the structural-interface convention — vscode-free). */
  log?: (line: string) => void;
}

export interface AmicodeServiceRunnerBoot {
  /** The service origin (trailing slash stripped) — the frontdoor's target. */
  url: string;
  /** The service's per-boot Basic header (accepts the engine token too). */
  authHeader: string;
  /** The engine credential the runner armed the spawn with — undefined in
   *  the unarmed posture (#955). Needed by harnesses that assert the proxy
   *  surfaces with the engine token. */
  enginePassword: string | undefined;
  /** The engine's origin (the proxy's upstream). */
  engineUrl: string;
  /** The spawned engine child (exposed for tests + exit supervision). */
  engine: ChildProcess;
  service: AmicodeServiceServer;
  /** Graceful teardown: stop the service, SIGTERM the engine (SIGKILL
   *  fallback bounded at 3s), wait for the child to actually exit. Resolves
   *  once; idempotent. */
  shutdown(): Promise<void>;
  /** Settles when the boot's lifetime ends: resolves after a deliberate
   *  shutdown(), rejects (named reason) if the engine exits unexpectedly —
   *  the supervisor the CLI's exit code hangs on. */
  done: Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) srv.close(() => resolve(addr.port));
      else {
        srv.close();
        reject(new Error("no port"));
      }
    });
    srv.on("error", reject);
  });
}

/** The ServerManager health-probe idiom: WITH the armed credential, else a
 *  healthy password-armed boot 401s an anonymous GET and reads as a timeout.
 *  `authorization` undefined = the unarmed posture's anonymous probe (#955):
 *  no credential exists, and the unarmed engine answers anonymous GETs. */
async function waitForHealth(baseUrl: string, timeoutMs: number, authorization: string | undefined): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, {
        headers: authorization === undefined ? {} : { Authorization: authorization },
        signal: AbortSignal.timeout(500),
      });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ── PID-file lifecycle helpers (#1578) ──────────────────────────────────────
// Exported for unit testing; the boot path calls them when opts.pidFile is set.

/** Check whether a PID is alive (signal 0 — no signal sent, just the liveness
 *  check). Returns false if the process does not exist or is not reachable. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check whether `pid` is an opencode process. Uses `ps -p <pid> -o comm=` on
 *  macOS/darwin and reads `/proc/<pid>/comm` on Linux. Returns false on any
 *  error (process gone, permission denied, etc.). */
export function isOpencodeProcess(pid: number): boolean {
  try {
    let comm: string;
    if (process.platform === "linux") {
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {
        return false;
      }
    } else {
      // macOS (darwin) and other POSIX: `ps -p <pid> -o comm=` prints the
      // command name with no header.
      comm = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8", timeout: 5_000 }).trim();
    }
    // The vendored binary's basename is "opencode" — match it (the comm field
    // is typically just the basename, but on macOS it can be the full path).
    const basename = comm.split("/").pop() ?? "";
    return basename === "opencode";
  } catch {
    return false;
  }
}

/** Write the engine's PID to the PID file (creates intermediate dirs). */
export function writePidFile(pidFile: string, pid: number): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${pid}\n`);
}

/** Remove the PID file. Best-effort: a missing file is silently ignored. */
export function removePidFile(pidFile: string, log: (line: string) => void): void {
  try {
    unlinkSync(pidFile);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`[service-runner] PID file removal failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Pre-boot cleanup: if a PID file exists and points at a live opencode
 *  process, SIGTERM it (with a 3s SIGKILL fallback). Best-effort: never
 *  blocks boot on failure. */
export async function cleanupStalePid(pidFile: string, log: (line: string) => void): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8").trim();
  } catch {
    return; // No PID file — nothing to clean up.
  }

  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    log(`[service-runner] PID file ${pidFile} has invalid content "${raw}" — ignoring`);
    return;
  }

  if (!isProcessAlive(pid)) {
    log(`[service-runner] stale PID file (pid ${pid} is dead) — ignoring`);
    return;
  }

  if (!isOpencodeProcess(pid)) {
    log(`[service-runner] PID ${pid} is alive but NOT an opencode process — skipping kill (safety check)`);
    return;
  }

  // It's alive and it's opencode — kill it.
  log(`[service-runner] killing stale opencode engine (pid ${pid}) from PID file`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Gone between the check and the kill — fine.
  }

  // Wait up to 3s for it to die, then SIGKILL.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isProcessAlive(pid)) return;
  }

  log(`[service-runner] stale engine (pid ${pid}) did not die after SIGTERM — sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Boot the runner's pair: engine + service. Throws AmicodeServiceRunnerError
 * (named reason) on any boot failure — never a silent half-boot. The CLI
 * entry maps a thrown error to a non-zero exit; the vitest suite drives this
 * same path in-process.
 */
export async function bootAmicodeServiceRunner(opts: AmicodeServiceRunnerOptions): Promise<AmicodeServiceRunnerBoot> {
  const log = opts.log ?? (() => undefined);

  // ── validate BEFORE spawning anything (named reasons, no half-boot) ──────
  if (opts.engineBin === "" || !existsSync(opts.engineBin))
    throw new AmicodeServiceRunnerError(`no engine binary at ${opts.engineBin} — set AMICODE_ENGINE_BIN (or run \`pnpm --filter amicode fetch:opencode\`)`);
  if (!existsSync(join(opts.appDistRoot, "index.html")))
    throw new AmicodeServiceRunnerError(`no built app dist at ${opts.appDistRoot} (missing index.html) — run \`pnpm --filter amicode run build:app\` or set AMICODE_APP_DIST`);

  // ── PID-file pre-boot cleanup (#1578) ───────────────────────────────────
  if (opts.pidFile) {
    await cleanupStalePid(opts.pidFile, log);
  }

  // ── the engine: spawn + health wait (the ServerManager/probe idiom) ──────
  // #955: engineUnarmed is the hub's anonymous boundary posture — no
  // OPENCODE_SERVER_PASSWORD in the child env, no credential minted, the
  // service gets enginePassword: undefined (its authMode still resolves
  // independently via AMICODE_SERVICE_AUTH). The armed default is untouched.
  const unarmed = opts.engineUnarmed === true;
  const password = unarmed ? undefined : (opts.enginePassword ?? mintServerPassword());
  const authHeader = password === undefined ? undefined : serverAuthHeader(password);
  const enginePort = opts.enginePort ?? 4094;
  const port = enginePort > 0 ? enginePort : await freePort();
  const engineUrl = `http://127.0.0.1:${port}`;

  const cwd = opts.engineCwd ?? mkdtempSync(join(tmpdir(), "amicode-service-runner-engine-"));
  mkdirSync(join(cwd, ".opencode"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "# amicode service runner\n");
  writeFileSync(
    join(cwd, ".opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  );

  const dbPin = opts.engineEnv?.OPENCODE_DB;
  log(
    `[service-runner] spawning engine ${opts.engineBin} serve --port=${port} (cwd=${cwd}${dbPin ? `, OPENCODE_DB=${dbPin}` : ", OPENCODE_DB=(host env)"})${unarmed ? " UNARMED (the hub's anonymous boundary posture)" : ""}`,
  );
  const engineEnv = {
    ...process.env,
    ...opts.engineEnv,
    ...(unarmed ? {} : { OPENCODE_SERVER_PASSWORD: password }),
  };
  if (unarmed) delete engineEnv.OPENCODE_SERVER_PASSWORD;

  const engine: ChildProcess = spawn(opts.engineBin, ["serve", "--port", String(port)], {
    cwd,
    // Unarmed = the key is ABSENT, never empty — the fork's route auth only
    // engages when the var is set, so an empty value would be a dishonest
    // half-posture.
    env: engineEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let engineLog = "";
  engine.stdout?.on("data", (d: Buffer) => (engineLog += d));
  engine.stderr?.on("data", (d: Buffer) => (engineLog += d));

  // ── PID-file write (#1578): record the engine child's PID ───────────────
  if (opts.pidFile && engine.pid !== undefined) {
    try {
      writePidFile(opts.pidFile, engine.pid);
      log(`[service-runner] wrote PID file ${opts.pidFile} (pid ${engine.pid})`);
    } catch (err) {
      log(`[service-runner] failed to write PID file (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const killEngine = () =>
    new Promise<void>((resolve) => {
      if (engine.exitCode !== null || engine.signalCode !== null) return resolve();
      const killTimer = setTimeout(() => {
        try {
          engine.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3_000);
      engine.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        engine.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

  const healthy = await waitForHealth(engineUrl, opts.healthTimeoutMs ?? 30_000, authHeader);
  if (!healthy) {
    await killEngine();
    throw new AmicodeServiceRunnerError(
      `engine not healthy within ${opts.healthTimeoutMs ?? 30_000}ms at ${engineUrl}`,
      `engine not healthy within ${opts.healthTimeoutMs ?? 30_000}ms at ${engineUrl}\n--- engine output ---\n${engineLog}`,
    );
  }
  log(`[service-runner] engine up at ${engineUrl}`);

  // ── the service: the SAME wiring startAmicodeService performs ────────────
  // No fleetActivation is ever passed here (H3): the hub runs the byte-
  // identical unarmed base service; arming is an extension-host decision.
  const service = createAmicodeService({
    engine: { password: unarmed ? undefined : password, getUrl: () => engineUrl },
    shelf: { distRoot: opts.appDistRoot },
  });
  const servicePort = opts.servicePort ?? 4095;
  let url: URL;
  try {
    if (servicePort > 0) {
      try {
        url = await service.start(servicePort);
      } catch {
        log(`[service-runner] port ${servicePort} busy, falling back to ephemeral`);
        url = await service.start();
      }
    } else {
      url = await service.start();
    }
  } catch (err) {
    // Fail-loud covers EVERY post-spawn boot failure: a service that never
    // came up must not leave its engine behind (the orphan the frontdoor
    // would silently keep proxying to on the next boot).
    await killEngine();
    throw new AmicodeServiceRunnerError(
      `the amicode service did not come up on port ${servicePort > 0 ? servicePort : "(ephemeral)"}`,
      `the amicode service did not come up on port ${servicePort > 0 ? servicePort : "(ephemeral)"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const origin = url.toString().replace(/\/$/, "");
  log(
    `[amicode-service] listening on ${origin} (${service.routeCount} routes; auth: per-boot Basic + engine token); app shelf mounted`,
  );

  // ── Handshake write (#1579): let the extension adopt instead of spawning ──
  if (opts.handshakePath) {
    try {
      writeHubHandshake({
        port,
        pid: engine.pid!,
        binaryHash: "", // placeholder — the runner doesn't compute binary hashes
        configHash: "", // placeholder
        dbPath: opts.engineEnv?.OPENCODE_DB,
        filePath: opts.handshakePath,
      });
      log(`[service-runner] wrote handshake to ${opts.handshakePath}`);
    } catch (err) {
      log(`[service-runner] failed to write handshake (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let shutDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((err: AmicodeServiceRunnerError) => void) | undefined;
  // The supervisor: an engine death OUTSIDE a deliberate shutdown is a
  // fail-loud (the frontdoor would be proxying a corpse), never a restart
  // guess — the hub restarts the whole unit (engine + service together).
  engine.once("exit", (code, signal) => {
    if (shutDown) return;
    rejectDone?.(
      new AmicodeServiceRunnerError(
        `engine exited unexpectedly (code=${code} signal=${signal})`,
        `engine exited unexpectedly (code=${code} signal=${signal})\n--- engine output ---\n${engineLog}`,
      ),
    );
  });
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutDown = true;
    shutdownPromise = (async () => {
      // ── Handshake removal (#1579): BEFORE killing the engine — order
      //    matters: the extension must not read a handshake for a dying engine.
      if (opts.handshakePath) {
        try { deleteHandshake(opts.handshakePath); } catch { /* best-effort */ }
      }
      await service.stop().catch(() => undefined);
      await killEngine();
      // ── PID-file removal (#1578) ──────────────────────────────────────
      if (opts.pidFile) {
        removePidFile(opts.pidFile, log);
      }
      log("[service-runner] stopped — service closed, engine torn down");
      resolveDone?.();
    })();
    return shutdownPromise;
  };

  return {
    url: origin,
    authHeader: service.authHeader,
    enginePassword: password,
    engineUrl,
    engine,
    service,
    shutdown,
    done,
  };
}
