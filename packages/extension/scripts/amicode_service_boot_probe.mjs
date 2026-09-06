#!/usr/bin/env node
// amicode_service_boot_probe.mjs — the #822 env-gated LIVE boot proof
// (the telaio_app_probe.mjs convention).
//
// Boots the REAL amicode service (bundled from this repo's own source — no
// transcribed logic, no drift) against a REAL spawned engine (the vendored
// opencode binary, password-armed) and a REAL built app dist, and asserts
// end-to-end from the service origin: the app document, an engine API call
// through the proxy, an SSE connect through the proxy, and one /amicode/*
// route — all with the ENGINE credential (the framed app's bootstrap, the
// zero-app-side-change contract).
//
// ENV-GATED (CI never builds the dist in this slice — the packaging-chore
// issue is the follow-up): with AMICODE_APP_DIST absent (or without an
// index.html) the probe SKIPS (exit 0) and says why. AMICODE_ENGINE_BIN
// defaults to the vendored binary (fetch:opencode); absent → skip.
//
// USAGE (the live phase / a dev machine):
//   node packages/extension/scripts/build_app_bundle.mjs          # stages dist/app
//   pnpm --filter amicode fetch:opencode                           # vendors the engine
//   AMICODE_APP_DIST=packages/extension/dist/app \
//     node packages/extension/scripts/amicode_service_boot_probe.mjs
//
// READ-ONLY EVIDENCE: boots, probes, reports, stops — never mutates state.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const skip = (msg) => {
  console.log(`[boot-probe] SKIP: ${msg}`);
  process.exit(0);
};

const APP_DIST = (process.env.AMICODE_APP_DIST ?? "").trim();
if (!APP_DIST) skip("AMICODE_APP_DIST not set — the env-gated live-phase script (CI has no built dist in this slice)");
if (!existsSync(join(APP_DIST, "index.html")))
  skip(`AMICODE_APP_DIST has no index.html (${APP_DIST}) — run \`pnpm --filter amicode run build:app\` first`);

const ENGINE_BIN = (process.env.AMICODE_ENGINE_BIN ?? "").trim() || join(PKG_ROOT, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
if (!existsSync(ENGINE_BIN)) skip(`no engine binary at ${ENGINE_BIN} — run \`pnpm --filter amicode fetch:opencode\` or set AMICODE_ENGINE_BIN`);

// Bundle the REAL service + probe entry from source (the same esbuild the
// extension build uses) into a throwaway ESM file, then run it. Bundling —
// not transpiling-by-hand — is the no-drift rule: the probe runs this repo's
// actual createAmicodeService, shelf, and proxy code.
const outDir = mkdtempSync(join(tmpdir(), "amicode-boot-probe-"));
const entry = join(PKG_ROOT, "src", "amicode_service_boot_probe.ts");
const outfile = join(outDir, "probe.mjs");
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile,
    sourcemap: false,
    minify: false,
    logLevel: "warning",
  });
  const r = spawnSync(process.execPath, [outfile], {
    stdio: "inherit",
    env: { ...process.env, AMICODE_APP_DIST: APP_DIST, AMICODE_ENGINE_BIN: ENGINE_BIN },
  });
  process.exit(r.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
