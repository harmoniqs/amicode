import { build } from 'esbuild'

// The library is consumed as TS source (main = src/index.ts; consumers bundle it
// via their own esbuild). We still bundle here as a build-time smoke check that
// the dep graph (ajv + ajv-formats + the JSON schemas) bundles cleanly into a
// single ESM module — the same way the extension/CLI will inline it.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  logLevel: 'info',
})
