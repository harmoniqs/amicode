#!/usr/bin/env node
// fleet_beta_smoke.mjs — the #398 fleet beta smoke WRAPPER (the
// amicode_service_boot_probe.mjs convention): bundles the REAL harness entry
// from this repo's own source (no transcribed logic, no drift) and runs it.
//
//   DRY (default):  pnpm --filter amicode run smoke:fleet
//     — everything local: a fixture hub is spawned, killed, hung, rejoined;
//       the entitlement + manifest + activation config are fixtures. Nothing
//       outside a temp dir is touched.
//
//   LIVE:  AMICODE_FLEET_SMOKE_LIVE=1 AMICODE_FLEET_HUB_URL=… \
//          AMICODE_FLEET_TUNNEL_ALIAS=… pnpm --filter amicode run smoke:fleet
//     — the machine's REAL entitlements + overlay source + hub credential,
//       against the REAL hub through the REAL tunnel. Destructive legs are
//       named skips, never run live. See FLEET_BETA.md for provisioning.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const outDir = mkdtempSync(join(tmpdir(), "amicode-fleet-smoke-"));
const entry = join(PKG_ROOT, "src", "fleet_beta_smoke.ts");
const outfile = join(outDir, "smoke.mjs");
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
  const r = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
