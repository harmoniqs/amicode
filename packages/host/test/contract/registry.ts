// The contract registry: for every upstream (specifier, symbol[, member]) the host uses, the shape the host
// relies on. This file is DATA plus one pure id-derivation helper — scripts/contract-scan.ts loads it to
// decide coverage, and test/contract/modules.test.ts / probe.ts assert each entry against the PUBLISHED
// package. It deliberately imports nothing from the engine.

/** What the host relies on for one export (or one member of an export). */
export type Shape = {
  /** `typeof` the export must have. "type" = compile-time only (nothing to assert at runtime; `tsc` is the gate). */
  is: "function" | "object" | "defined" | "type"
  /** For functions: bounds on `.length` (declared parameters), so a removed/added required parameter is noticed. */
  arity?: { min?: number; max?: number }
  /** Used members of this export (namespace-like objects: `Effect.runPromise`, `SessionRestart.Service`). */
  members?: Record<string, Shape>
  /** Extra behavioural assertion over the live value; return a problem string, or undefined when fine. */
  check?: (value: unknown) => string | undefined
  /** True for entry points the host is about to use (plugin registration): checked, but not demanded by the scan. */
  anticipated?: boolean
}
export type ModuleContract = Record<string, Shape>
export type Contracts = Record<string, ModuleContract>

/** Every id a registry names: `spec`, `spec#symbol`, `spec#symbol.member`. */
export function contractIds(contracts: Contracts) {
  return Object.entries(contracts).flatMap(([specifier, module]) => [
    specifier,
    ...Object.entries(module).flatMap(([symbol, shape]) => [
      `${specifier}#${symbol}`,
      ...Object.keys(shape.members ?? {}).map((member) => `${specifier}#${symbol}.${member}`),
    ]),
  ])
}

export const CONTRACTS: Contracts = {}
