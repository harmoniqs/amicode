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

/**
 * An acknowledged "underivable" import site: a dynamic `import(<expression>)` whose specifier is computed, so no
 * package contract can be named for it. The scan fails on any site not listed here (a NEW non-literal import must be
 * acknowledged by a person, with a reason and the contract that stands in for it). Sites are matched by file and
 * expression text, not line number, so an unrelated edit above does not break the match; `line` is informational.
 */
export type DynamicAllowance = {
  readonly file: string
  readonly text: string
  readonly line: number
  readonly reason: string
  /** The test that proves the dynamically loaded file registers/runs, standing in for a package contract. */
  readonly contract: string
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

export const DYNAMIC_IMPORTS: readonly DynamicAllowance[] = [
  {
    file: "plugins/index.ts",
    text: "import(file)",
    line: 84,
    reason: "loads the user plugin modules named in AMICODE_HOST_PLUGIN_CONFIG.modules: the path is operator input, not a package specifier.",
    contract: "test/contract/loader.test.ts (a user plugin file registers through fromPromise and its hooks fire in a real host)",
  },
  {
    file: "plugins/context.ts",
    text: "import(path.join(directory, file))",
    line: 126,
    reason: "loads the v1 context builders from the extension's opencode-plugin directory (context.extensionDir): a path, not a package specifier.",
    contract: "test/contract/loader.test.ts (the extension builders' output reaches the model request)",
  },
]

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
  // Anticipated: the plugin registration entry point the host's plugin hook-up (#2062) builds on. Not yet imported
  // by src/, so the scan does not demand it; plugin.test.ts asserts its behaviour. Once src/ imports it, the entry
  // becomes demanded like any other (drop `anticipated`).
  "@opencode/core/plugin/sdk": {
    SdkPlugins: { is: "object", anticipated: true, members: { Service: { is: "function", check: tag, anticipated: true } } },
  },
  // The plugin API the host's plugin set (src/plugins/**) is written against. `Plugin`, `Plugin.Plugin` ({ id, setup })
  // and `Plugin.Context` (the hook surface) are used only as TYPES: types.contract.ts is their gate. `fromPromise`
  // is how the seam hands a Promise-form plugin to SdkPlugins.register.
  "@opencode/plugin": {
    Plugin: { is: "type", members: { Context: type, Plugin: type } },
  },
  "@opencode/plugin/promise/adapter": {
    fromPromise: fn(1),
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
