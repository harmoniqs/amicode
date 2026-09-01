import { defineConfig } from "vitest/config";

// The SLOW tier's config (test:slow). vitest.config.ts deliberately excludes
// `**/slow/**` so the fast suite (`vitest run --exclude '**/slow/**'`) never
// collects the slow tier — but that blanket exclude ALSO swallowed the slow
// tier's own runner: `vitest run test/slow` matched no files and exited 1
// (found while proving SEAM 7's env-gated real-store test, #709 — the script
// had been unrunnable since the config landed). This config is the minimal
// repair: same setup guard as the fast suite, slow tier collectable.
// Slow tests self-gate on env (skipIf) — the fast suite still never runs them.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/slow/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
