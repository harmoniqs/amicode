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

/** id -> shape (undefined for a bare module id). */
export function contractShapes(contracts: Contracts) {
  return new Map<string, Shape | undefined>(
    Object.entries(contracts).flatMap(([specifier, module]) => [
      [specifier, undefined] as const,
      ...Object.entries(module).flatMap(([symbol, shape]) => [
        [`${specifier}#${symbol}`, shape] as const,
        ...Object.entries(shape.members ?? {}).map(([member, memberShape]) => [`${specifier}#${symbol}.${member}`, memberShape] as const),
      ]),
    ]),
  )
}

const fn = (max?: number): Shape => ({ is: "function", ...(max === undefined ? {} : { arity: { max } }) })
const type: Shape = { is: "type" }
const tag = (value: unknown) =>
  typeof (value as { key?: unknown })?.key === "string" ? undefined : "expected a service tag (a class carrying a string `key`)"

/**
 * One entry per upstream import the host's sources make (scripts/contract-scan.ts derives the demand; this file
 * answers it). Arity bounds are tripwires: an upstream that grows a REQUIRED parameter raises `.length` and
 * fails here, to be reviewed rather than discovered in production.
 */
export const CONTRACTS: Contracts = {
  "@opencode/server/routes": {
    // createRoutes(options?, serviceURLs?, overrides?) -> Layer; the seam passes (options, () => []).
    createRoutes: { ...fn(3), check: (v) => (typeof v === "function" ? undefined : "not callable") },
  },
  "@opencode/core/session/execution/restart": {
    SessionRestart: {
      is: "object",
      members: { Service: { is: "function", check: tag } },
    },
  },
  effect: {
    Context: { is: "object", members: { get: fn(2) } },
    Effect: {
      is: "object",
      members: { Effect: type, gen: fn(0), runFork: fn(2), runPromise: fn(2), scope: { is: "defined" }, sync: fn(1) },
    },
    Exit: { is: "object", members: { void: { is: "defined", check: (v) => ((v as { _tag?: string })._tag === "Success" ? undefined : "Exit.void is not a Success") } } },
    Layer: { is: "object", members: { buildWithScope: fn(2), provide: fn(2) } },
    Scope: { is: "object", members: { addFinalizer: fn(2), close: fn(2), make: fn(1) } },
  },
  "effect/http": {
    HttpEffect: { is: "object", members: { toWebHandlerWith: fn(1) } },
    HttpMiddleware: { is: "object", members: { make: fn(1) } },
    HttpRouter: { is: "object", members: { HttpRouter: { is: "function", check: tag } } },
    HttpServer: { is: "object", members: { layerServices: { is: "defined" } } },
    HttpServerResponse: { is: "object", members: { HttpServerResponse: type } },
  },
}
