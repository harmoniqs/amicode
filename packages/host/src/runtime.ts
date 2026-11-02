/** Why this process cannot host, or undefined when it can. Bun only: under Node the V1 -> V2 importer is a no-op and its migrations drop data. */
export function runtimeProblem(globals: { Bun?: unknown } = globalThis) {
  return globals.Bun === undefined ? "amicode-host requires Bun; refusing to run under Node (the V1 -> V2 importer is a silent no-op there and its migrations drop data)" : undefined
}
