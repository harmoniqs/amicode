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

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { createAmicodeService } from "./amicode_service";
import type { AmicodeServiceServer } from "./amicode_service/server";
import { mintServerPassword, serverAuthHeader } from "./server_auth";

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
      await service.stop().catch(() => undefined);
      await killEngine();
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
