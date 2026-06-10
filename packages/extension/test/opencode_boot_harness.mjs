// Small standalone harness that invokes prepareOpencodeProject and prints
// the resulting project dir on stdout.

import * as path from "node:path";
import { prepareOpencodeProject } from "../src/opencode_config.ts";

// bundle rebases import.meta.url to /tmp; harness gets repo via env.
const repo = process.env.AMICODE_V2_REPO;
if (!repo) { process.stderr.write("AMICODE_V2_REPO unset\n"); process.exit(2); }

const { projectDir, agentsPath } = prepareOpencodeProject({
  binDir:    path.resolve(repo, "bin"),
  agentsSrc: path.resolve(repo, "AGENTS.md"),
});

process.stdout.write(`PROJECT=${projectDir}\n`);
process.stderr.write(`agents=${agentsPath}\n`);
