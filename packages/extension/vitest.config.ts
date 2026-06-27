import { defineConfig } from "vitest/config";
import path from "node:path";

// Alias the `vscode` module to a minimal stub so node-side modules that import it
// (file_watcher.ts, etc.) can be unit-tested without the VS Code host. Only kicks
// in for `import ... from "vscode"`; node-only tests are unaffected.
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(process.cwd(), "test/__mocks__/vscode.ts") },
  },
});
