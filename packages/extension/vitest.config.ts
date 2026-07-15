import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

// Alias the `vscode` module to a minimal stub so node-side modules that import it
// (file_watcher.ts, etc.) can be unit-tested without the VS Code host. Only kicks
// in for `import ... from "vscode"`; node-only tests are unaffected.
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(process.cwd(), "test/__mocks__/vscode.ts") },
  },
  plugins: [
    // Match esbuild.config.mjs's `loader: {".svg": "text"}`: Vite's own default
    // .svg handling returns a URL string, not raw markup, which would make
    // icon.ts's canonical-file import silently no-op under test (a broken
    // string assigned to innerHTML) while still passing under the real build.
    {
      name: "svg-as-raw-text",
      transform(_code: string, id: string) {
        if (!id.endsWith(".svg")) return undefined;
        return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
