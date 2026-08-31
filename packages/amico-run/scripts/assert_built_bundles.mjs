// The #643 bundle-build gate: the CLI package's dist bundles are gitignored
// build artifacts, and the deployed verb-router bundle went 46 days stale
// because nothing gated the build — a broken entry or unresolvable import
// only failed on whichever machine last tried to build (the incident: the
// checkout's node_modules had drifted, the local build died, the stale dist
// kept shipping). CI calls this after `pnpm --filter @amicode/amico-run build`
// (see .github/workflows/ci.yml bundle-build-gate), and the vitest suite
// exercises both directions (test/bundle_gate.test.ts).
//
// What it asserts, per DECLARED bin of the CLI package (packages/amico-run
// package.json `bin` map + `amicode.shadowBins` — the single source of truth,
// the same map the extension staging and scripts/assert_packaged_cli.mjs
// re-read):
//   1. the build produced dist/<basename>.js, non-empty (a declared-but-
//      unbuilt bin reds — half-built sets are the stale-bundle signature);
//   2. the built verb router still ANSWERS: `amico --help` exits 0 printing
//      the usage surface. The unit suite never proves this — vitest transpiles
//      instead of bundling, so the shipped artifact is only executed here and
//      by the packaging gates (the createRequire/yaml seam shipped exactly
//      this way: every test green, the binary dead on first import).
//
// Usage:  node scripts/assert_built_bundles.mjs [--pkg-dir <dir>]
//   --pkg-dir  the amico-run package dir to gate (default: this script's ../)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Declared bins → dist file layout. Staging convention (extension
 * esbuild.config.mjs): bin key K ships from launcher basename B as
 * dist/<B>.js — for both the npm `bin` map and the `amicode.shadowBins`
 * map (whose key and launcher basename coincide, e.g. `gh`). */
export function declaredDistBundles(pkgDir = PKG_ROOT) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const bin = pkg.bin;
  if (!bin || typeof bin !== "object" || Object.keys(bin).length === 0)
    throw new Error(`${pkgDir}/package.json: no \`bin\` map — nothing to gate is a failure, not a pass`);
  const fromMap = Object.entries(bin).map(([name, launcherPath]) => ({
    name,
    dist: `${basename(String(launcherPath))}.js`,
  }));
  const shadow = Object.entries(pkg.amicode?.shadowBins ?? {}).map(([name, launcherPath]) => ({
    name,
    dist: `${basename(String(launcherPath))}.js`,
  }));
  // dedup by dist path (a shadow key colliding with a declared basename)
  const seen = new Set();
  return [...fromMap, ...shadow].filter((b) => (seen.has(b.dist) ? false : (seen.add(b.dist), true)));
}

/** The verb-router smoke: `amico --help` is the side-effect-free invocation —
 * pure usage print before any env or surface read (src/amico.ts main). */
const ROUTER_BIN = "amico";

function execCapture(file, args) {
  return new Promise((resolveP) => {
    execFile(file, args, { timeout: 30_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolveP({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Run the gate. Returns { ok, results } with one row per check — { bin,
 *  check, ok, detail } — never throwing on a failing bundle (the caller gets
 *  the full picture, mirroring assert_packaged_cli.mjs). */
export async function runBundleGate({ pkgDir = PKG_ROOT } = {}) {
  const results = [];
  const push = (bin, check, detail) =>
    results.push({ bin, check, ok: detail === null, detail: detail ?? "ok" });
  const distDir = join(pkgDir, "dist");
  const bundles = declaredDistBundles(pkgDir);

  // 1. every declared bundle built + non-empty
  for (const b of bundles) {
    const p = join(distDir, b.dist);
    if (!existsSync(p)) {
      push(b.name, "dist bundle built", `missing from the build output: ${p}`);
      continue;
    }
    if (statSync(p).size === 0) {
      push(b.name, "dist bundle built", `empty bundle (zero bytes): ${p}`);
      continue;
    }
    push(b.name, "dist bundle built", null);
  }

  // 2. the verb-router smoke — only meaningful when the router built
  const router = bundles.find((b) => b.name === ROUTER_BIN);
  if (!router) {
    push(ROUTER_BIN, "verb-router smoke (--help)", `no "${ROUTER_BIN}" bin declared — the verb router is the gate's subject`);
  } else if (existsSync(join(distDir, router.dist))) {
    const r = await execCapture(process.execPath, [join(distDir, router.dist), "--help"]);
    if (r.code !== 0) push(ROUTER_BIN, "verb-router smoke (--help)", `amico --help exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`);
    else if (!/usage:/.test(r.stdout)) push(ROUTER_BIN, "verb-router smoke (--help)", "--help exited 0 but printed no usage surface — wrong bundle?");
    else push(ROUTER_BIN, "verb-router smoke (--help)", null);
  }
  return { ok: results.every((r) => r.ok), results };
}

async function main(argv) {
  let pkgDir = PKG_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pkg-dir") pkgDir = resolve(argv[++i]);
    else {
      console.error(`assert_built_bundles: unknown arg ${argv[i]} (usage: [--pkg-dir <dir>])`);
      return 2;
    }
  }
  console.log(`[bundle-gate] package dir: ${pkgDir}`);
  const { ok, results } = await runBundleGate({ pkgDir });
  for (const r of results)
    console.log(`[bundle-gate] ${r.ok ? "PASS" : "FAIL"}  ${r.bin.padEnd(20)} ${r.check}${r.ok ? "" : ` — ${r.detail}`}`);
  console.log(
    ok
      ? `[bundle-gate] OK — every declared bundle is built and the verb router answers`
      : `[bundle-gate] FAILED — the bundle build is stale or incomplete (see FAIL lines)`,
  );
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (e) => {
      console.error(`[bundle-gate] ${e.message}`);
      process.exitCode = 1;
    },
  );
}
