import { defineConfig } from "vitest/config";

// The only reason this file exists is `setupFiles`: test/setup.ts installs the guard that stops
// any test from spawning a real (billed) model call or appending to the developer's real ledger.
// Both are failures that per-test discipline cannot prevent, because the risk is in the test
// someone writes next.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // Matches the historical `--exclude '**/slow/**'` in the package script; kept here so the
    // exclusion survives someone running `vitest` directly.
    exclude: ["**/node_modules/**", "**/dist/**", "**/slow/**"],
  },
});
