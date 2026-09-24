// esbuild bundle for the always-local ui-kind companion (#1274, ADR 0025 P2).
// One extension-host entry, bundled CJS with `vscode` external — the same shape
// as the main extension's host bundle (packages/extension/esbuild.config.mjs),
// minus every webview/CLI target. This is a SPIKE artifact: it holds no engine
// or store (never-fork), so there is nothing else to bundle.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const target = {
  entryPoints: ["src/companion.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/companion.js",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(target);
  await ctx.watch();
  console.log("[esbuild] watching companion…");
} else {
  await build(target);
}
