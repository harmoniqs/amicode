// Runs in a sandboxed child process (the engine computes its global dirs at import time). Imports every
// specifier the registry names from the PUBLISHED packages and checks each symbol/member against its Shape.
// Prints one JSON object on the last stdout line: { results: { <id>: null | "<problem>" }, behaviours: {...} }.
import { CONTRACTS, type Shape } from "./registry.ts"
import { behaviours } from "./behaviours.ts"

const results: Record<string, string | null> = {}

function check(value: unknown, shape: Shape): string | null {
  if (shape.is === "type") return null // compile-time only; `tsc` is the gate
  if (value === undefined || value === null) return "export is missing (undefined)"
  if (shape.is === "function") {
    if (typeof value !== "function") return `expected a function, got ${typeof value}`
    const length = (value as (...args: unknown[]) => unknown).length
    if (shape.arity?.max !== undefined && length > shape.arity.max) return `declares ${length} parameters, host relies on at most ${shape.arity.max}`
    if (shape.arity?.min !== undefined && length < shape.arity.min) return `declares ${length} parameters, host relies on at least ${shape.arity.min}`
  }
  if (shape.is === "object" && typeof value !== "object" && typeof value !== "function") return `expected an object, got ${typeof value}`
  return shape.check?.(value) ?? null
}

for (const [specifier, module] of Object.entries(CONTRACTS)) {
  const loaded = await import(specifier).then(
    (ns: Record<string, unknown>) => ns,
    (error: unknown) => String(error instanceof Error ? error.message : error).split("\n")[0]!,
  )
  if (typeof loaded === "string") {
    results[specifier] = `does not load: ${loaded}`
    for (const [symbol, shape] of Object.entries(module)) {
      results[`${specifier}#${symbol}`] = `module ${specifier} does not load`
      for (const member of Object.keys(shape.members ?? {})) results[`${specifier}#${symbol}.${member}`] = `module ${specifier} does not load`
    }
    continue
  }
  results[specifier] = null
  for (const [symbol, shape] of Object.entries(module)) {
    const value = loaded[symbol]
    results[`${specifier}#${symbol}`] = check(value, shape)
    for (const [member, memberShape] of Object.entries(shape.members ?? {})) {
      results[`${specifier}#${symbol}.${member}`] =
        value === undefined || value === null ? `parent export ${symbol} is missing` : check((value as Record<string, unknown>)[member], memberShape)
    }
  }
}

const scenarios: Record<string, string | null> = {}
for (const [name, run] of Object.entries(behaviours))
  scenarios[name] = await run().then(
    (problem) => problem ?? null,
    (error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
  )

console.log(JSON.stringify({ results, scenarios }))
process.exit(0)
