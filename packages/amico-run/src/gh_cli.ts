// The `gh` bin entry point (issue #399). Thin by design (the pasqal_cli.ts
// split): resolve argv → ghShimMain() → set the exit code. The logic — real-gh
// resolution, token carriage, passthrough — lives in gh_shim.ts and is unit-
// tested there; even the unexpected-error lane prints only the error's own
// text (github_app.ts guarantees no ConfigError message carries a secret).
import { ghShimMain } from "./gh_shim.js";

ghShimMain(process.argv.slice(2)).then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    console.error(`amico-gh: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 64;
  },
);
