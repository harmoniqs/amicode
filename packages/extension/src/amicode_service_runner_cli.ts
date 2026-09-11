// amicode_service_runner_cli — the ENV-DRIVEN CLI entry of the production
// service runner (#955), bundled by esbuild.config.mjs to
// bin/dist/amicode-service-runner.mjs (the mcp-amico.mjs convention: one
// self-contained ESM file plain `node` runs — the deployed hub bundle carries
// it alongside the app dist; no build tooling at runtime).
//
// ENV SURFACE (all optional unless named required):
//   AMICODE_ENGINE_BIN   the engine binary. Default: the vendored opencode
//                        the fetch:opencode lane produces, resolved relative
//                        to THIS bundle (bin/dist → the package root's
//                        vendor/opencode/<platform>-<arch>/opencode).
//   AMICODE_APP_DIST     REQUIRED — the shelf's dist root (the built app
//                        bundle). A missing/unbuilt dist fails LOUDLY: the
//                        runner is production, the NEEDS-SETUP placeholder
//                        is the extension's degradation, not a hub shape.
//   AMICODE_SERVICE_PORT the service's port. Default 4095.
//   AMICODE_ENGINE_PORT  the engine's internal port (the proxy's upstream).
//                        Default 4094.
//   AMICODE_ENGINE_CWD   the engine's working directory. Default: a
//                        synthesized throwaway project (the probe's pattern).
//   AMICODE_ENGINE_PASSWORD  the engine credential to arm the spawn with.
//                        Default: a fresh random mint per boot. The hub
//                        deployment sets it: the ops layer owns the
//                        credential so the frontdoor's ?auth_token= carrier
//                        shares the engine's auth.
//   AMICODE_ENGINE_UNARMED  "=1" spawns the engine WITHOUT any credential —
//                        the hub's anonymous boundary posture (#955; the
//                        fork's "canonical serves anonymous 200"). The pair
//                        with AMICODE_SERVICE_AUTH=open is the hub posture.
//                        Wins over AMICODE_ENGINE_PASSWORD.
//   OPENCODE_DB          the canonical pin — passed through to the spawned
//                        engine untouched (the hub's session store).
//
// EXIT CODES: 0 = graceful (SIGTERM/SIGINT teardown completed); 1 = any
// boot/lifecycle failure, with a `[service-runner] FAIL: <reason>` line on
// stderr — never a silent half-boot, never a hang.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AmicodeServiceRunnerError, bootAmicodeServiceRunner } from "./amicode_service_runner";

const invokedAsMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

function defaultEngineBin(): string {
  // bin/dist/amicode-service-runner.mjs → bin/dist → bin → the package root
  // → the vendored binary (the fetch:opencode lane's output path).
  const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return join(pkgRoot, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
}

const envInt = (name: string): number | undefined => {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

async function main(): Promise<never> {
  const appDist = (process.env.AMICODE_APP_DIST ?? "").trim();
  const engineBin = (process.env.AMICODE_ENGINE_BIN ?? "").trim() || defaultEngineBin();

  if (appDist === "")
    throw new AmicodeServiceRunnerError(
      "AMICODE_APP_DIST not set — the runner needs the built app dist root to serve",
    );
  if (!existsSync(engineBin))
    throw new AmicodeServiceRunnerError(
      `no engine binary at ${engineBin} — set AMICODE_ENGINE_BIN (or run \`pnpm --filter amicode fetch:opencode\`)`,
    );

  const boot = await bootAmicodeServiceRunner({
    engineBin,
    appDistRoot: appDist,
    servicePort: envInt("AMICODE_SERVICE_PORT") ?? 4095,
    enginePort: envInt("AMICODE_ENGINE_PORT") ?? 4094,
    engineCwd: (process.env.AMICODE_ENGINE_CWD ?? "").trim() || undefined,
    enginePassword: (process.env.AMICODE_ENGINE_PASSWORD ?? "").trim() || undefined,
    engineUnarmed: (process.env.AMICODE_ENGINE_UNARMED ?? "").trim() === "1",
    engineEnv: (process.env.OPENCODE_DB ?? "").trim() ? { OPENCODE_DB: process.env.OPENCODE_DB } : undefined,
    log: (line) => console.log(line),
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      console.log(`[service-runner] ${sig} — tearing down engine + service`);
      void boot.shutdown().finally(() => process.exit(0));
    });
  }

  // The supervisor: resolve on graceful shutdown, fail loud if the engine
  // dies under the service.
  await boot.done;
  process.exit(0);
}

if (invokedAsMain) {
  main().catch((err: unknown) => {
    if (err instanceof AmicodeServiceRunnerError) console.error(`[service-runner] FAIL: ${err.message}`);
    else console.error(`[service-runner] FAIL: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
