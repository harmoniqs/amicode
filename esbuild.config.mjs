import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

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
  },
  // amico-mcp standalone server (spawned by opencode)
  {
    entryPoints: ["mcp/index.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: "dist/amico-mcp.js",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
  // opencode plugin (loaded inside the opencode runtime)
  {
    entryPoints: ["plugin/index.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: "dist/amicode-plugin.mjs",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[esbuild] watching all four bundles…");
} else {
  await Promise.all(targets.map((t) => build(t)));
}
