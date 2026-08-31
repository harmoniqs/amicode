// Typed surface of scripts/assert_built_bundles.mjs for the test suite (the
// amico-run tsconfig includes test/, unlike the extension package's — hence
// this declaration rather than an untyped import).

export interface DeclaredDistBundle {
  /** bin key (npm `bin` map) or shadow-bin name (`amicode.shadowBins`) */
  name: string;
  /** dist file basename, e.g. "amico.js" (launcher basename + .js) */
  dist: string;
}

export interface BundleGateRow {
  bin: string;
  check: string;
  ok: boolean;
  detail: string;
}

export function declaredDistBundles(pkgDir?: string): DeclaredDistBundle[];

export function runBundleGate(opts?: { pkgDir?: string }): Promise<{ ok: boolean; results: BundleGateRow[] }>;
