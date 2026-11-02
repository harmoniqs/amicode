#!/usr/bin/env bun
// Contract scanner (#2064, H1d). Derives, from the host's own sources, every upstream package the host
// imports (`@opencode/*` and `effect`, `effect/*`) together with the named symbols — and the members of
// those symbols — it uses, then checks each one is named by a contract in test/contract/registry.ts.
//
//   bun scripts/contract-scan.ts                 human table + coverage; exit 1 when a pair has no contract
//   bun scripts/contract-scan.ts --json          the same, as stable JSON
//   bun scripts/contract-scan.ts --inventory     inventory only (no coverage check, exit 0)
//   bun scripts/contract-scan.ts --root <dir>    scan <dir> instead of src/ and bin/ (repeatable)
//
// The inventory is never maintained by hand: it is whatever the TypeScript parser finds in the sources.
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { contractIds, contractShapes, CONTRACTS, DYNAMIC_IMPORTS, type Contracts, type DynamicAllowance } from "../test/contract/registry.ts"

export type Kind = "value" | "type"
export type Member = { name: string; kind: Kind }
export type Entry = { specifier: string; symbol: string; kind: Kind; members: Member[]; files: string[] }
export type Underivable = { file: string; line: number; text: string }
export type Inventory = { entries: Entry[]; underivable: Underivable[] }

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
/** Symbol recorded for `import "x"` (no bindings) — the module itself must resolve. */
export const MODULE_SYMBOL = "(module)"
/** Symbol recorded when the used names cannot be determined (`export *`, a bare `import()` value). */
export const STAR_SYMBOL = "*"

/** Specifiers the host's contract suite is responsible for. */
export const relevant = (specifier: string) =>
  specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@opencode/")

export function scanSources(roots: string[]): Inventory {
  const entries = new Map<string, Entry>()
  const underivable: Underivable[] = []
  const add = (specifier: string, symbol: string, kind: Kind, file: string, member?: Member) => {
    const key = `${specifier}\0${symbol}`
    const entry = entries.get(key) ?? { specifier, symbol, kind, members: [], files: [] }
    entries.set(key, entry)
    if (kind === "value") entry.kind = "value"
    if (!entry.files.includes(file)) entry.files.push(file)
    if (!member) return
    const known = entry.members.find((m) => m.name === member.name)
    if (!known) entry.members.push(member)
    else if (member.kind === "value") known.kind = "value"
  }

  for (const root of roots) {
    for (const full of sourceFiles(root)) {
      const text = fs.readFileSync(full, "utf8")
      const file = path.relative(root, full).split(path.sep).join("/")
      scanFile(ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, scriptKind(full)), file, add, underivable)
    }
  }

  const sorted = [...entries.values()]
    .map((entry) => ({
      ...entry,
      members: entry.members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      files: entry.files.sort(),
    }))
    .sort((a, b) => compare(a.specifier, b.specifier) || compare(a.symbol, b.symbol))
  return { entries: sorted, underivable: underivable.sort((a, b) => compare(a.file, b.file) || a.line - b.line) }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full)
      return SOURCE_EXT.has(path.extname(entry.name)) ? [full] : []
    })
}

function scriptKind(file: string) {
  const ext = path.extname(file)
  if (ext === ".tsx") return ts.ScriptKind.TSX
  if (ext === ".jsx") return ts.ScriptKind.JSX
  return [".js", ".mjs", ".cjs"].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

type Add = (specifier: string, symbol: string, kind: Kind, file: string, member?: Member) => void
type Binding = { specifier: string; symbol: string }

function scanFile(sf: ts.SourceFile, file: string, add: Add, underivable: Underivable[]) {
  // local name -> the imported symbol(s) it stands for (member accesses are attributed to them)
  const symbolLocals = new Map<string, Binding[]>()
  // local name -> module namespace (member accesses are themselves the imported symbols)
  const namespaceLocals = new Map<string, { specifier: string; kind: Kind }[]>()
  const bindSymbol = (local: string, binding: Binding) =>
    symbolLocals.set(local, [...(symbolLocals.get(local) ?? []), binding])
  const bindNamespace = (local: string, specifier: string, kind: Kind) =>
    namespaceLocals.set(local, [...(namespaceLocals.get(local) ?? []), { specifier, kind }])
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const literal = (node: ts.Node | undefined) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

  /** Record the names bound by `const { a, b: c, ...rest } = <module>` (or a `.then(({ a }) => …)` parameter). */
  function fromPattern(pattern: ts.ObjectBindingPattern, specifier: string) {
    for (const element of pattern.elements) {
      const imported = element.dotDotDotToken
        ? STAR_SYMBOL
        : element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : ts.isIdentifier(element.name)
            ? element.name.text
            : STAR_SYMBOL
      add(specifier, imported, "value", file)
      if (ts.isIdentifier(element.name)) bindSymbol(element.name.text, { specifier, symbol: imported })
    }
  }

  /** `expr` evaluates to a module namespace object (an awaited `import()` or a `require()`); see how it is used. */
  function moduleValue(expr: ts.Expression, specifier: string) {
    const parent = expr.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === expr) {
      if (ts.isObjectBindingPattern(parent.name)) return fromPattern(parent.name, specifier)
      if (ts.isIdentifier(parent.name)) return bindNamespace(parent.name.text, specifier, "value")
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === expr) {
      if (parent.name.text === "then" && ts.isCallExpression(parent.parent)) {
        const callback = parent.parent.arguments[0]
        const param = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.parameters[0] : undefined
        if (param && ts.isObjectBindingPattern(param.name)) return fromPattern(param.name, specifier)
        if (param && ts.isIdentifier(param.name)) return bindNamespace(param.name.text, specifier, "value")
        return add(specifier, STAR_SYMBOL, "value", file)
      }
      return add(specifier, parent.name.text, "value", file)
    }
    if (ts.isExpressionStatement(parent)) return add(specifier, MODULE_SYMBOL, "value", file)
    add(specifier, STAR_SYMBOL, "value", file)
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier)
      if (specifier && relevant(specifier)) {
        const clause = node.importClause
        if (!clause) add(specifier, MODULE_SYMBOL, "value", file)
        else {
          const declKind: Kind = clause.isTypeOnly ? "type" : "value"
          if (clause.name) {
            add(specifier, "default", declKind, file)
            bindSymbol(clause.name.text, { specifier, symbol: "default" })
          }
          const bindings = clause.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) bindNamespace(bindings.name.text, specifier, declKind)
          if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements) {
              const symbol = (element.propertyName ?? element.name).text
              add(specifier, symbol, declKind === "type" || element.isTypeOnly ? "type" : "value", file)
              bindSymbol(element.name.text, { specifier, symbol })
            }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier)
      if (specifier && relevant(specifier)) {
        const declKind: Kind = node.isTypeOnly ? "type" : "value"
        const clause = node.exportClause
        if (!clause || ts.isNamespaceExport(clause)) add(specifier, STAR_SYMBOL, declKind, file)
        else
          for (const element of clause.elements)
            add(specifier, (element.propertyName ?? element.name).text, declKind === "type" || element.isTypeOnly ? "type" : "value", file)
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression)
      if (specifier && relevant(specifier)) bindNamespace(node.name.text, specifier, node.isTypeOnly ? "type" : "value")
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) {
        const specifier = literal(node.arguments[0])
        if (specifier === undefined) {
          if (isDynamicImport) underivable.push({ file, line: lineOf(node), text: node.getText(sf).slice(0, 120) })
        } else if (relevant(specifier)) {
          let expr: ts.Expression = node
          while (ts.isParenthesizedExpression(expr.parent)) expr = expr.parent
          if (ts.isAwaitExpression(expr.parent)) {
            expr = expr.parent
            while (ts.isParenthesizedExpression(expr.parent)) expr = expr.parent
          }
          moduleValue(expr, specifier)
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      const specifier = ts.isLiteralTypeNode(arg) ? literal(arg.literal) : undefined
      if (specifier && relevant(specifier)) {
        let first: ts.EntityName | undefined = node.qualifier
        while (first && ts.isQualifiedName(first)) first = first.left
        add(specifier, first ? first.text : STAR_SYMBOL, "type", file)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Second pass: member accesses on the names the first pass bound.
  function members(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) use(node.expression.text, node.name.text, "value")
    else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const key = literal(node.argumentExpression)
      if (key !== undefined) use(node.expression.text, key, "value")
    } else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) use(node.left.text, node.right.text, "type")
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    )
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) use(node.initializer.text, name.text, "value")
      }
    ts.forEachChild(node, members)
  }
  function use(local: string, name: string, kind: Kind) {
    for (const binding of symbolLocals.get(local) ?? [])
      add(binding.specifier, binding.symbol, kind, file, { name, kind })
    for (const ns of namespaceLocals.get(local) ?? []) add(ns.specifier, name, kind === "value" ? ns.kind : "type", file)
  }
  members(sf)
}

// ---------------------------------------------------------------------------------------------------------
// Coverage

/** Everything the inventory demands a contract for: the module, each symbol, and each used member. */
export function requiredIds(inventory: Inventory) {
  return [
    ...new Set(
      inventory.entries.flatMap((entry) => [
        entry.specifier,
        `${entry.specifier}#${entry.symbol}`,
        ...entry.members.map((member) => `${entry.specifier}#${entry.symbol}.${member.name}`),
      ]),
    ),
  ].sort()
}

export function coverage(inventory: Inventory, contracts: Contracts, dynamic: readonly DynamicAllowance[] = []) {
  const required = requiredIds(inventory)
  const have = new Set(contractIds(contracts))
  const shapes = contractShapes(contracts)
  // The host uses it at runtime but the contract says "compile-time only": nothing would ever assert it exists.
  const mismatched = inventory.entries.flatMap((entry) => {
    const id = `${entry.specifier}#${entry.symbol}`
    return [
      ...(entry.kind === "value" && shapes.get(id)?.is === "type" ? [id] : []),
      ...entry.members.filter((m) => m.kind === "value" && shapes.get(`${id}.${m.name}`)?.is === "type").map((m) => `${id}.${m.name}`),
    ]
  })
  // Each allowance covers one occurrence of (file, expression); anything left over is unacknowledged.
  const unused = [...dynamic]
  const unacknowledged = inventory.underivable.filter((site) => {
    const at = unused.findIndex((allowance) => allowance.file === site.file && allowance.text === site.text)
    if (at < 0) return true
    unused.splice(at, 1)
    return false
  })
  return {
    required,
    unacknowledged,
    staleAllowances: unused,
    uncovered: required.filter((id) => !have.has(id)),
    mismatched,
    // contracts nobody demands: kept (they may be anticipated entry points) but surfaced
    unused: [...have].filter((id) => !required.includes(id) && !contractIsAnticipated(contracts, id)).sort(),
  }
}

function contractIsAnticipated(contracts: Contracts, id: string) {
  const [specifier = "", symbol] = id.split("#")
  const symbolName = symbol?.split(".")[0]
  const entry = symbolName ? contracts[specifier]?.[symbolName] : undefined
  return entry ? entry.anticipated === true : Object.values(contracts[specifier] ?? {}).every((c) => c.anticipated === true)
}

export function report(inventory: Inventory, contracts: Contracts, dynamic: readonly DynamicAllowance[] = []) {
  return { inventory, ...coverage(inventory, contracts, dynamic) }
}

export function table(inventory: Inventory, uncovered: string[] | undefined) {
  const miss = new Set(uncovered ?? [])
  const rows = inventory.entries.map((entry) => {
    const id = `${entry.specifier}#${entry.symbol}`
    const gaps = entry.members.filter((member) => miss.has(`${id}.${member.name}`)).map((member) => member.name)
    const status = !uncovered
      ? "-"
      : miss.has(entry.specifier) || miss.has(id) || gaps.length ? `UNCOVERED${gaps.length ? ` (${gaps.join(",")})` : ""}` : "covered"
    return [
      entry.specifier,
      entry.symbol,
      entry.kind,
      entry.members.map((member) => member.name).join(", "),
      entry.files.join(", "),
      status,
    ]
  })
  const head = ["SPECIFIER", "SYMBOL", "KIND", "MEMBERS", "FILES", "CONTRACT"]
  const widths = head.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)))
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n")
}

// ---------------------------------------------------------------------------------------------------------
// CLI

if (import.meta.main) {
  const args = process.argv.slice(2)
  const packageRoot = path.resolve(import.meta.dir, "..")
  const roots: string[] = []
  let json = false
  let inventoryOnly = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--json") json = true
    else if (arg === "--inventory") inventoryOnly = true
    else if (arg === "--root" && args[i + 1]) roots.push(path.resolve(args[++i]!))
    else {
      console.error(`contract-scan: unknown argument ${arg}\nusage: contract-scan.ts [--json] [--inventory] [--root <dir>]...`)
      process.exit(2)
    }
  }
  const inventory = scanSources(roots.length ? roots : [path.join(packageRoot, "src"), path.join(packageRoot, "bin")])
  const result = report(inventory, CONTRACTS, DYNAMIC_IMPORTS)
  if (json) console.log(JSON.stringify(inventoryOnly ? { inventory } : result, null, 2))
  else {
    console.log(table(inventory, inventoryOnly ? undefined : result.uncovered))
    if (inventory.underivable.length)
      console.log(
        `\nUNDERIVABLE dynamic imports (specifier is not a string literal; no package contract can be named, so each must be acknowledged in DYNAMIC_IMPORTS):\n` +
          inventory.underivable
            .map((u) => `  ${u.file}:${u.line}  ${u.text}  [${result.unacknowledged.includes(u) ? "NOT ACKNOWLEDGED" : "acknowledged"}]`)
            .join("\n"),
      )
    if (!inventoryOnly && result.staleAllowances.length)
      console.log(`\nDYNAMIC_IMPORTS entries matching no import site (informational):\n  ${result.staleAllowances.map((a) => `${a.file} ${a.text}`).join("\n  ")}`)
    if (!inventoryOnly && result.unused.length) console.log(`\ncontracts nothing in the sources demands (informational):\n  ${result.unused.join("\n  ")}`)
  }
  if (!inventoryOnly) {
    const problems = [
      ...(result.mismatched.length
        ? [`${result.mismatched.length} import(s) are used at runtime but their contract says "type" (compile-time only):\n` + result.mismatched.map((id) => `  - ${id}`).join("\n")]
        : []),
      ...(result.unacknowledged.length
        ? [
            `${result.unacknowledged.length} dynamic import(s) with a non-literal specifier are not acknowledged in DYNAMIC_IMPORTS (test/contract/registry.ts):\n` +
              result.unacknowledged.map((u) => `  - ${u.file}:${u.line}  ${u.text}`).join("\n"),
          ]
        : []),
      ...(result.uncovered.length
        ? [`${result.uncovered.length} upstream import(s) have NO contract in test/contract/registry.ts:\n` + result.uncovered.map((id) => `  - ${id}`).join("\n")]
        : []),
    ]
    if (problems.length) {
      console.error("\n" + problems.map((problem) => `contract-scan: ${problem}`).join("\n\n"))
      process.exit(1)
    }
  }
}
