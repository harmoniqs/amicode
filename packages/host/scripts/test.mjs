#!/usr/bin/env node
// `pnpm test` entry for @amicode/host. The suite needs Bun (the host refuses to run under Node), but
// the generic `pnpm -r run test` job (`fast`) has no Bun. Without Bun this prints a loud SKIPPED banner
// and exits 0 so the monorepo job is not red for an unrelated reason. It does NOT claim a pass.
// The real gate is the `host-tests` job (ci/host-tests-job.patch). Set AMICODE_HOST_REQUIRE_BUN=1 to make
// a missing Bun a hard failure (that job sets it).
import { spawnSync } from "node:child_process"

const probe = spawnSync("bun", ["--version"], { encoding: "utf8" })
if (probe.error || probe.status !== 0) {
  const banner = "@amicode/host tests SKIPPED: bun is not available in this job (the host-tests job runs them)."
  if (process.env.AMICODE_HOST_REQUIRE_BUN === "1") {
    console.error("ERROR: " + banner + " AMICODE_HOST_REQUIRE_BUN=1 forbids skipping.")
    process.exit(1)
  }
  console.log("::warning title=@amicode/host tests skipped::" + banner)
  console.log("**************************************************************")
  console.log(banner)
  console.log("**************************************************************")
  process.exit(0)
}
const run = spawnSync("bun", ["test", ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(run.status ?? 1)
