// Planted-break support for the drill (drill.test.ts): build a COPY of the host package whose module
// resolution sees the published upstream packages with one export (or one member of a namespace-like export)
// removed — "the upstream stopped exporting X to us" — then run the real contract suite inside that copy.
//
//   plantBreak("@opencode/server/routes#createRoutes")     export removed
//   plantBreak("effect#Scope.close")                       member removed from a namespace-like export
//
// The copy gets its own node_modules: every package is a symlink to the real installed one, except the
// broken package, which is a directory whose files are symlinks to the real ones EXCEPT the single module file
// the specifier resolves to; that file is replaced by a generated shim re-exporting the real module (by
// absolute path) minus the broken name. Nothing in the real install (or the shared pnpm store) is modified,
// and the engine's own internal imports keep resolving to the real files: only the host's view changes.
import fs from "node:fs"
import path from "node:path"
import { packageRoot } from "./support.ts"

export type PlantedBreak = { specifier: string; symbol: string; member?: string }

export function parseBreak(spec: string): PlantedBreak {
  const [specifier = "", target = ""] = spec.split("#")
  const [symbol = "", member] = target.split(".")
  if (!specifier || !symbol) throw new Error(`bad planted break ${JSON.stringify(spec)} (expected specifier#symbol[.member])`)
  return { specifier, symbol, member }
}

export function plantBreak(spec: string, tmpRoot = "/tmp/opencode") {
  const planted = parseBreak(spec)
  const root = fs.mkdtempSync(path.join(tmpRoot, "h1d-break-"))
  const copy = path.join(root, "host")
  fs.mkdirSync(copy)
  for (const name of ["src", "bin", "test", "scripts", "package.json", "tsconfig.json"]) {
    fs.cpSync(path.join(packageRoot, name), path.join(copy, name), { recursive: true })
  }

  // node_modules: symlink everything, then replace the one module file.
  const realModules = path.join(packageRoot, "node_modules")
  const modules = path.join(copy, "node_modules")
  fs.mkdirSync(modules)
  const realFile = fs.realpathSync(Bun.resolveSync(planted.specifier, packageRoot))
  const pkgName = planted.specifier.split("/").slice(0, planted.specifier.startsWith("@") ? 2 : 1).join("/")
  for (const entry of fs.readdirSync(realModules)) {
    if (entry.startsWith("@")) {
      fs.mkdirSync(path.join(modules, entry))
      for (const child of fs.readdirSync(path.join(realModules, entry))) {
        if (`${entry}/${child}` !== pkgName) fs.symlinkSync(fs.realpathSync(path.join(realModules, entry, child)), path.join(modules, entry, child))
      }
    } else if (entry !== pkgName) fs.symlinkSync(fs.realpathSync(path.join(realModules, entry)), path.join(modules, entry))
  }
  const realPackage = fs.realpathSync(path.join(realModules, pkgName))
  const relative = path.relative(realPackage, realFile)
  if (relative.startsWith("..")) throw new Error(`${planted.specifier} resolved outside its package (${realFile})`)
  const brokenPackage = path.join(modules, pkgName)
  fs.mkdirSync(path.dirname(brokenPackage), { recursive: true })
  mirror(realPackage, brokenPackage, relative.split(path.sep), shimSource(realFile, planted))
  return { root, copy, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Recreate `from` at `to` with symlinks, except the file at `trail` which becomes `contents`. */
function mirror(from: string, to: string, trail: string[], contents: string) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from)) {
    const source = path.join(from, entry)
    if (entry !== trail[0]) fs.symlinkSync(source, path.join(to, entry))
    else if (trail.length === 1) fs.writeFileSync(path.join(to, entry), contents)
    else mirror(source, path.join(to, entry), trail.slice(1), contents)
  }
}

function shimSource(realFile: string, planted: PlantedBreak) {
  const names = new Bun.Transpiler({ loader: "js" }).scan(fs.readFileSync(realFile, "utf8")).exports
  const real = JSON.stringify(realFile)
  const identifier = /^[A-Za-z_$][\w$]*$/
  const kept = names.filter((name) => name !== planted.symbol && name !== "default" && identifier.test(name))
  const lines = [
    `// planted break: ${planted.specifier}#${planted.symbol}${planted.member ? "." + planted.member : ""}`,
    ...(kept.length ? [`export { ${kept.join(", ")} } from ${real}`] : []),
    ...(names.includes("default") ? [`export { default } from ${real}`] : []),
  ]
  if (planted.member && names.includes(planted.symbol))
    lines.push(
      `import * as real from ${real}`,
      `export const ${planted.symbol} = Object.fromEntries(Object.entries(real.${planted.symbol}).filter(([name]) => name !== ${JSON.stringify(planted.member)}))`,
    )
  return lines.join("\n") + "\n"
}
