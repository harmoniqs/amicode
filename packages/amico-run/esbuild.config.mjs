import { build } from "esbuild";
import { chmodSync } from "node:fs";

// Three bins from one package: the historical `amico-run` (entry cli.ts), the `amico`
// verb router (entry amico.ts, issue #108) — both sharing the launch path (src/launch.ts;
// amico.ts additionally bundles the spine verbs + the mcp-serve facade) — and the
// `amico-pasqal` connector launcher (entry pasqal_cli.ts, issue #168: token env-injection,
// secrets off argv).
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  // ESM, not CJS: the package is "type": "module", so node executes the bundle as ESM —
  // a CJS bundle would die on `require is not defined in ES module scope`.
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  logLevel: "info",
};

for (const [entry, outfile] of [
  ["src/cli.ts", "dist/amico-run.js"],
  ["src/amico.ts", "dist/amico.js"],
  ["src/pasqal_cli.ts", "dist/amico-pasqal.js"],
]) {
  await build({ ...common, entryPoints: [entry], outfile });
  chmodSync(outfile, 0o755);
}
