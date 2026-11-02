// The scanner derives the inventory of upstream imports from source text. These tests feed it every import
// form the host may use and assert the inventory exactly, so a scanner blind spot is a failing test here
// rather than a silently missing contract.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { scanSources, type Inventory } from "../../scripts/contract-scan.ts"

const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

function scanText(source: string, name = "fixture.ts"): Inventory {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h1d-scan-"))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, name), source)
  return scanSources([dir])
}

/** Compact, order-stable rendering of an inventory: "spec#symbol(kind)[member:kind,...]". */
function render(inventory: Inventory) {
  return inventory.entries.map(
    (entry) =>
      `${entry.specifier}#${entry.symbol}(${entry.kind})` +
      (entry.members.length ? `[${entry.members.map((m) => `${m.name}:${m.kind}`).join(",")}]` : ""),
  )
}

describe("scanner: import forms", () => {
  test("static named import with member accesses on the imported name", () => {
    const inv = scanText(`import { Effect } from "effect"\nEffect.runPromise(x)\nEffect.gen(function* () {})\n`)
    expect(render(inv)).toEqual(["effect#Effect(value)[gen:value,runPromise:value]"])
  })

  test("aliased import is attributed to the original export name; members follow the alias", () => {
    const inv = scanText(`import { Effect as E } from "effect"\nE.sync(() => 1)\n`)
    expect(render(inv)).toEqual(["effect#Effect(value)[sync:value]"])
  })

  test("import type and inline type modifiers are kind=type; a value use of the same symbol wins", () => {
    const inv = scanText(
      `import type { A } from "@opencode/server/a"\nimport { type B, C } from "@opencode/server/b"\nimport type { D } from "@opencode/server/d"\nimport { D as D2 } from "@opencode/server/d"\nD2.go()\nvoid C\n`,
    )
    expect(render(inv)).toEqual([
      "@opencode/server/a#A(type)",
      "@opencode/server/b#B(type)",
      "@opencode/server/b#C(value)",
      "@opencode/server/d#D(value)[go:value]",
    ])
  })

  test("qualified names in type positions are type members", () => {
    const inv = scanText(`import type { Effect } from "effect"\nexport type T = Effect.Effect<number>\n`)
    expect(render(inv)).toEqual(["effect#Effect(type)[Effect:type]"])
  })

  test("re-exports: named, star and namespace", () => {
    const inv = scanText(
      `export { A } from "@opencode/core/a"\nexport * from "@opencode/core/b"\nexport * as ns from "@opencode/core/c"\nexport type { T } from "@opencode/core/d"\n`,
    )
    expect(render(inv)).toEqual([
      "@opencode/core/a#A(value)",
      "@opencode/core/b#*(value)",
      "@opencode/core/c#*(value)",
      "@opencode/core/d#T(type)",
    ])
  })

  test("dynamic import with a destructured result (the server seam's style), including renames", () => {
    const inv = scanText(
      `async function f() {\n  const { createRoutes } = await import("@opencode/server/routes")\n  const { a: b, c } = await import("effect/http")\n  b(); c()\n}\n`,
    )
    expect(render(inv)).toEqual([
      "@opencode/server/routes#createRoutes(value)",
      "effect/http#a(value)",
      "effect/http#c(value)",
    ])
  })

  test("dynamic import bound to a name: member accesses become symbols; property access on the awaited import too", () => {
    const inv = scanText(
      `async function f() {\n  const mod = await import("effect/http")\n  mod.HttpRouter\n  const x = (await import("effect")).Layer\n  void x\n}\n`,
    )
    expect(render(inv)).toEqual(["effect#Layer(value)", "effect/http#HttpRouter(value)"])
  })

  test(".then callbacks: destructured and identifier parameters", () => {
    const inv = scanText(
      `import("@opencode/core/a").then(({ A }) => A)\nimport("@opencode/core/b").then((m) => m.B)\n`,
    )
    expect(render(inv)).toEqual(["@opencode/core/a#A(value)", "@opencode/core/b#B(value)"])
  })

  test("namespace import, import-equals and require", () => {
    const inv = scanText(
      `import * as O from "@opencode/util/o"\nO.thing()\nimport legacy = require("@opencode/util/legacy")\nlegacy.old()\nconst r = require("effect/Option")\nr.some(1)\n`,
      "fixture.cts",
    )
    expect(render(inv)).toEqual(["@opencode/util/legacy#old(value)", "@opencode/util/o#thing(value)", "effect/Option#some(value)"])
  })

  test("default and side-effect imports", () => {
    const inv = scanText(`import Def from "@opencode/x/def"\nimport "@opencode/x/polyfill"\nvoid Def\n`)
    expect(render(inv)).toEqual(["@opencode/x/def#default(value)", "@opencode/x/polyfill#(module)(value)"])
  })

  test("import types: import('x').Sym", () => {
    const inv = scanText(`export type T = import("@opencode/core/t").Thing\nexport type U = typeof import("effect")\n`)
    expect(render(inv)).toEqual(["@opencode/core/t#Thing(type)", "effect#*(type)"])
  })

  test("destructuring members off an imported namespace-like symbol", () => {
    const inv = scanText(`import { Effect } from "effect"\nconst { runPromise, runFork } = Effect\nvoid runPromise\nvoid runFork\n`)
    expect(render(inv)).toEqual(["effect#Effect(value)[runFork:value,runPromise:value]"])
  })

  test("only @opencode/* and effect(/*) count; look-alikes and relative/node imports are ignored", () => {
    const inv = scanText(
      `import a from "effect-ts"\nimport b from "@effect/platform"\nimport c from "./local.ts"\nimport d from "node:fs"\nimport e from "@opencode-ai/x"\nimport f from "bun:test"\nvoid [a, b, c, d, e, f]\n`,
    )
    expect(render(inv)).toEqual([])
  })

  test("files are recorded relative to the scan root; the same pair from two files merges", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h1d-scan-"))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, "sub"))
    fs.writeFileSync(path.join(dir, "a.ts"), `import { Effect } from "effect"\nEffect.sync\n`)
    fs.writeFileSync(path.join(dir, "sub", "b.ts"), `import { Effect } from "effect"\nEffect.fn\n`)
    const inv = scanSources([dir])
    expect(inv.entries).toHaveLength(1)
    expect(inv.entries[0]!.files).toEqual(["a.ts", "sub/b.ts"])
    expect(inv.entries[0]!.members.map((m) => m.name)).toEqual(["fn", "sync"])
  })

  test("a dynamic import whose specifier is not a literal is reported as underivable, not dropped", () => {
    const inv = scanText(`const name = "x"\nawait import(name)\nawait import(\`@opencode/\${name}\`)\n`)
    expect(inv.entries).toEqual([])
    expect(inv.underivable.map((u) => u.line)).toEqual([2, 3])
  })

  test("node_modules and unreadable file types are skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h1d-scan-"))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, "node_modules"))
    fs.writeFileSync(path.join(dir, "node_modules", "x.ts"), `import { A } from "@opencode/x"\n`)
    fs.writeFileSync(path.join(dir, "notes.md"), `import { A } from "@opencode/x"\n`)
    expect(scanSources([dir]).entries).toEqual([])
  })
})
