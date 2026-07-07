import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  // ESM, not CJS: the package is "type": "module", so node executes dist/amico-run.js
  // as ESM — a CJS bundle would die on `require is not defined in ES module scope`.
  format: "esm",
  outfile: "dist/amico-run.js",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
});
chmodSync("dist/amico-run.js", 0o755);
