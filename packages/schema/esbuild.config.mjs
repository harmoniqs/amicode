import { build } from "esbuild";
import { chmodSync } from "node:fs";

// The library is consumed as TS source (main = src/index.ts; consumers bundle it
// via their own esbuild). We bundle two artifacts here:
//   - dist/index.js: a smoke check that the dep graph (ajv + ajv-formats + the
//     JSON schemas) bundles cleanly into a single ESM module.
//   - dist/amico-validate.js: the standalone validator CLI (0.1c).
const common = { bundle: true, platform: "node", target: "node20", format: "esm", sourcemap: true, logLevel: "info" };

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/amico-validate.js",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/amico-validate.js", 0o755);
