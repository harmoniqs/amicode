import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const watch = process.argv.includes("--watch");

// Stage EVERY bin the CLI package declares (its package.json `bin` map is the
// single source of truth — #161: hand-listing bins here is how amico-pasqal
// shipped declared-but-unstaged) so `bin/launcher/<name>` finds
// `bin/dist/<name>.js` (each launcher execs node "$DIR/../dist/<name>.js").
// Package-time artifact; the dev Extension Host uses the sibling-launcher
// fallback (resolveAmicoRunBinDir). Runs in both build and --watch (CWD = the
// package dir under `pnpm run`). Missing bundles WARN here (dev-friendly:
// `pnpm --filter amicode build` alone must not die) — CI reds them via
// scripts/assert_packaged_cli.mjs, which re-reads the same bin map.
const arRoot = "../amico-run";
const declaredBins = Object.values(JSON.parse(readFileSync(`${arRoot}/package.json`, "utf8")).bin ?? {}).map((p) =>
  basename(p),
);
if (declaredBins.some((name) => existsSync(`${arRoot}/dist/${name}.js`))) {
  mkdirSync("bin/launcher", { recursive: true });
  mkdirSync("bin/dist", { recursive: true });
  for (const name of declaredBins) {
    if (!existsSync(`${arRoot}/dist/${name}.js`)) {
      console.warn(`[esbuild] amico-run/dist/${name}.js not built — "${name}" will be absent from the package`);
      continue;
    }
    cpSync(`${arRoot}/launcher/${name}`, `bin/launcher/${name}`, { dereference: true });
    cpSync(`${arRoot}/dist/${name}.js`, `bin/dist/${name}.js`, { dereference: true });
    chmodSync(`bin/launcher/${name}`, 0o755); // guarantee +x survives pack/unpack
  }
} else {
  console.warn("[esbuild] amico-run/dist not built — run `pnpm --filter @amicode/amico-run build` before packaging");
}

const targets = [
  // extension host entry point
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
  // catalog-card dev preview webview bundle (#47 scaffold)
  {
    entryPoints: ["src/catalog_card_webview.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/catalog_card_webview.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
    loader: { ".svg": "text" },
  },
  // bottom-panel Run Inspector webview bundle
  {
    entryPoints: ["src/inspector_webview.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/inspector_webview.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
    loader: { ".svg": "text" },
  },
  // panel Device Inspector webview bundle (Spec A §3 — sibling to the Run Inspector)
  {
    entryPoints: ["src/device_inspector_webview.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/device_inspector_webview.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
    loader: { ".svg": "text" },
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[esbuild] watching both bundles…");
} else {
  await Promise.all(targets.map((t) => build(t)));
}
