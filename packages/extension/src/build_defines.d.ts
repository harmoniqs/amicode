// Build-time constants injected by esbuild.config.mjs `define` (#2017).
// Absent under vitest/tsc-only runs — always read through a `typeof` guard.

/** packages/extension/package.json `version`, baked into the extension and
 *  the standalone service-runner bundles. */
declare const __AMICODE_VERSION__: string | undefined;
