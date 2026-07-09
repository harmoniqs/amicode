import { build } from "esbuild";
import { chmodSync } from "node:fs";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  // ESM, not CJS: the package is "type": "module", so node executes the bundles
  // as ESM — a CJS bundle would die on `require is not defined in ES module scope`.
  format: "esm",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/amico-run.js",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/amico-run.js", 0o755);

// Harness-reframe prototype demo (amicode#109, slice B4): bundles the harness
// driver + its deterministic fake experimenter leaf so `demo:harness` runs one
// iteration end-to-end with NO LLM and NO Julia. It shells out to the sibling
// dist/amico-run.js built above.
await build({
  ...common,
  entryPoints: ["harness-demo/run_demo.ts"],
  outfile: "dist/harness-demo.js",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/harness-demo.js", 0o755);
