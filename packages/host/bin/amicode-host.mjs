#!/usr/bin/env bun
// Launcher. Plain JavaScript on purpose: it must run (and refuse clearly) under any runtime, including
// Node, before a single TypeScript or engine module is loaded.
if (typeof Bun === "undefined") {
  console.error(
    "amicode-host: requires Bun; refusing to run under Node (the V1 -> V2 importer is a silent no-op there and its migrations drop data). Run: bun packages/host/bin/amicode-host.mjs",
  )
  process.exit(64)
}
const { main } = await import("../src/main.ts")
process.exit(await main())
