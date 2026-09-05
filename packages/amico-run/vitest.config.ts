import { defineConfig, type Plugin } from "vitest/config";
import { readFileSync } from "node:fs";

// The only reason this file exists is `setupFiles`: test/setup.ts installs the guard that stops
// any test from spawning a real (billed) model call or appending to the developer's real ledger.
// Both are failures that per-test discipline cannot prevent, because the risk is in the test
// someone writes next.

// Data-as-import parity with esbuild.config.mjs's `.toml: "text"` loader
// (#820): under vitest the same resources/*.toml files load as their text
// content, so the canonical seed has ONE copy and both runtimes read it.
function tomlAsText(): Plugin {
  return {
    name: "toml-as-text",
    load(id) {
      if (id.endsWith(".toml")) {
        return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [tomlAsText()],
  test: {
    setupFiles: ["./test/setup.ts"],
    // Matches the historical `--exclude '**/slow/**'` in the package script; kept here so the
    // exclusion survives someone running `vitest` directly.
    exclude: ["**/node_modules/**", "**/dist/**", "**/slow/**"],
  },
});
