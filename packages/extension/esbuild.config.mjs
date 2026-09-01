import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
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
const arPkg = JSON.parse(readFileSync(`${arRoot}/package.json`, "utf8"));
const declaredBins = Object.values(arPkg.bin ?? {}).map((p) => basename(p));
// #399 SHADOW bins (the package's `amicode.shadowBins` map): staged into
// bin/launcher so they ride the extension's prepended PATH — but deliberately
// NOT in the npm `bin` map, because a bin-map entry makes pnpm link the name
// into node_modules/.bin where it shadows the DEVELOPER's tooling for every
// pnpm script (CI's fetch:opencode died exactly that way: its `gh` resolved to
// our shim, which re-found the .bin alias, and pnpm's wrapper grew NODE_PATH
// on every recursive pass until exec hit E2BIG). The shadowing contract is
// agent-session-only: extension bin dir, nowhere else.
const shadowBins = Object.entries(arPkg.amicode?.shadowBins ?? {}).map(([name, p]) => ({
  name,
  launcher: basename(String(p)),
}));
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
  for (const { name, launcher } of shadowBins) {
    const distName = launcher.replace(/(?:\.js)?$/, "") + ".js";
    if (!existsSync(`${arRoot}/dist/${distName}`)) {
      console.warn(`[esbuild] amico-run/dist/${distName} not built — shadow bin "${name}" will be absent from the package`);
      continue;
    }
    cpSync(`${arRoot}/launcher/${launcher}`, `bin/launcher/${name}`, { dereference: true });
    cpSync(`${arRoot}/dist/${distName}`, `bin/dist/${distName}`, { dereference: true });
    chmodSync(`bin/launcher/${name}`, 0o755);
  }
  // The CLI bundles are ESM (amico-run has "type": "module"); without a scoped
  // marker node warns-and-reparses on EVERY invocation (MODULE_TYPELESS_PACKAGE_JSON
  // on stderr — noise on a channel the run gate reserves for failures). A
  // bin/-scoped package.json fixes parse mode without touching the extension host
  // entry (dist/extension.js stays CJS under the root package.json).
  writeFileSync("bin/package.json", JSON.stringify({ type: "module" }) + "\n");
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
  // Chat Deck webview bundle — pane-manager shell (src/deck/shell.ts + model)
  {
    entryPoints: ["src/deck/shell.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/deck_shell.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
  // Onboarding webview bundle — Stage 0 model setup (#433)
  {
    entryPoints: ["src/onboarding_webview.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/onboarding_webview.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
  // The MCP stdio transport of the amicode_* tool surface (#700): bundles the
  // harness-neutral core (src/amicode_tools_core.ts) + the official MCP SDK
  // into ONE self-contained ESM file opencode's `mcp.amicode` local config
  // spawns with plain `node` — the portable carrier (any MCP client can drive
  // it), not an opencode-specific plugin. .mjs keeps parse-mode explicit under
  // the extension's CJS root package.json regardless of bin/package.json.
  {
    entryPoints: ["src/mcp_amico_server.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: "bin/dist/mcp-amico.mjs",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
  // Sidebar webview bundle — workspace panel (#673)
  {
    entryPoints: ["src/sidebar_webview.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/sidebar_webview.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[esbuild] watching both bundles…");
} else {
  await Promise.all(targets.map((t) => build(t)));
}
