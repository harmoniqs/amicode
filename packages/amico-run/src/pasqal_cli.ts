// The `amico-pasqal` bin entry point (issue #168). The launcher logic lives in
// pasqal_launch.ts (the cli.ts / launch.ts split) — this file is intentionally thin:
// resolve argv → pasqalLaunch() → set the process exit code. SECURITY: even the
// unexpected-error lane prints only the error's own text — pasqal_launch.ts
// guarantees no ConfigError message ever carries the token, and the token itself
// lives only in the child env, never in any argv or log line.
import { pasqalLaunch } from "./pasqal_launch.js";

pasqalLaunch(process.argv.slice(2)).then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    // Any unexpected throw is a launcher fault, not a connector failure → 64.
    console.error(`amico-pasqal: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 64;
  },
);
