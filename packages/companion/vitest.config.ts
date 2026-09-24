import { defineConfig } from "vitest/config";
import path from "node:path";

// Alias the `vscode` module to a minimal stub so the companion's extension-host
// entry (src/companion.ts) can be unit-tested without the VS Code host — the
// same pattern the main extension uses (packages/extension/vitest.config.ts).
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(process.cwd(), "test/__mocks__/vscode.ts") },
  },
});
