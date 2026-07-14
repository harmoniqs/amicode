// The `amico-run` bin entry point. The launch logic itself lives in launch.ts so the new
// `amico` verb router (amico.ts, issue #108) can call the SAME launch path without
// re-running this bootstrap. This file is intentionally thin: resolve argv → launch() →
// set the process exit code, with the historical amico-run error/exit semantics unchanged.
import { launch } from "./launch.js";

launch(process.argv.slice(2)).then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    // Any unexpected throw is an orchestrator fault, not a solve failure → 64.
    console.error(`amico-run: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 64;
  },
);
