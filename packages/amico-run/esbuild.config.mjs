import { build } from "esbuild";
import { chmodSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

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

// WRITE ATOMICALLY — build to a unique temp path, then rename into place.
//
// Why: ten test files run this config in their own `beforeAll` while OTHER test files
// concurrently `execFileSync("node", [dist/amico.js, …])`. esbuild writing in place
// truncates the bundle a sibling file is mid-execution on, so node exits 1 with empty
// stdout and the sibling's assertion fails with a bare `expected 1 to be +0` or a
// `SyntaxError: Unexpected end of input` from JSON.parse-ing nothing. That is a real
// intermittent-CI race, and it is invisible when you re-run the failing file alone.
//
// rename(2) is atomic within a filesystem, so a concurrent reader gets either the whole
// old bundle or the whole new one — never a partial. The pid+counter suffix keeps two
// concurrent builds from colliding on the temp path itself.
// Build into a temp DIRECTORY keeping the final basename, then rename both artifacts
// into dist/. Building to a temp *filename* instead would bake that temp name into the
// bundle's trailing `//# sourceMappingURL=` comment, so the shipped bundle would point
// at a map that no longer exists — sourcemaps silently broken, tests all still green.
// The URL is relative to the output file, so preserving the basename keeps it correct.
const staging = mkdtempSync(join("dist", "build-"));
try {
  for (const [entry, name] of [
    ["src/cli.ts", "amico-run.js"],
    ["src/amico.ts", "amico.js"],
    ["src/pasqal_cli.ts", "amico-pasqal.js"],
  ]) {
    const tmp = join(staging, name);
    await build({ ...common, entryPoints: [entry], outfile: tmp });
    chmodSync(tmp, 0o755);
    renameSync(tmp, join("dist", name));
    try {
      renameSync(`${tmp}.map`, join("dist", `${name}.map`));
    } catch {
      /* sourcemap is best-effort — never fail a build over it */
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
