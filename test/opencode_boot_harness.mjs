// Small standalone harness that invokes prepareOpencodeProject and prints
// the resulting project dir on stdout.

import * as path from "node:path";
import { prepareOpencodeProject } from "../src/opencode_config.ts";

// bundle rebases import.meta.url to /tmp; harness gets repo via env.
const repo = process.env.AMICODE_V2_REPO;
if (!repo) { process.stderr.write("AMICODE_V2_REPO unset\n"); process.exit(2); }
const dist = path.resolve(repo, "dist");

const { projectDir, configPath } = prepareOpencodeProject({
  distDir: dist,
  extensionCallbackUrl: "http://127.0.0.1:9999",
  juliaScriptPath: path.resolve(repo, "..", "amicode", "julia", "spike_solve.jl"),
  juliaProject:    "/tmp/amicode-spike-julia",
});

process.stdout.write(`PROJECT=${projectDir}\n`);
process.stderr.write(`config=${configPath}\n`);
