import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, chmodSync } from "node:fs";

const watch = process.argv.includes("--watch");

// Stage amico-run so `bin/launcher/amico-run` finds `bin/dist/amico-run.js`
// (the launcher execs node "$DIR/../dist/amico-run.js"). Package-time artifact;
// the dev Extension Host uses the sibling-launcher fallback (resolveAmicoRunBinDir).
// Runs in both build and --watch (CWD = the package dir under `pnpm run`).
const arRoot = "../amico-run";
if (existsSync(`${arRoot}/dist/amico-run.js`)) {
  mkdirSync("bin/launcher", { recursive: true });
  mkdirSync("bin/dist", { recursive: true });
  cpSync(`${arRoot}/launcher/amico-run`, "bin/launcher/amico-run", { dereference: true });
  cpSync(`${arRoot}/dist/amico-run.js`, "bin/dist/amico-run.js", { dereference: true });
  chmodSync("bin/launcher/amico-run", 0o755); // guarantee +x survives pack/unpack
  // The `amico` spine verbs (catalog/vault/device/note) ship beside amico-run:
  // same launcher dir, so the single PATH prepend resolves both bins. Without
  // this block the verb surface is unreachable in the installed build
  // (spec-20260711-132200 §1 finding 1: implemented, undiscoverable, unshipped).
  if (existsSync(`${arRoot}/dist/amico.js`)) {
    cpSync(`${arRoot}/launcher/amico`, "bin/launcher/amico", { dereference: true });
    cpSync(`${arRoot}/dist/amico.js`, "bin/dist/amico.js", { dereference: true });
    chmodSync("bin/launcher/amico", 0o755);
    // `amico-vault` == `amico vault` (reuses dist/amico.js). Lets opencode's
    // /amicode/vaults (the Vaults tab) resolve a vault CLI via Bun.which without
    // depending on the ops-repo ~/.amico/ops/scripts/amico-vault script.
    cpSync(`${arRoot}/launcher/amico-vault`, "bin/launcher/amico-vault", { dereference: true });
    chmodSync("bin/launcher/amico-vault", 0o755);
  } else {
    console.warn("[esbuild] amico-run/dist/amico.js not built — spine verbs will be absent from the package");
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
