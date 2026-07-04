import { describe, it, expect } from 'vitest'
import { mkdtempSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Regression guard (#81). DEPLOYMENT REALITY: AGENTS.md tells the agent to COPY the
// solve template into a scratch dir and run THAT copy — `julia <scratch>/solve.jl`
// (see AGENTS.md "Workflow" step 2/3). So inside the running script @__DIR__ is the
// scratch dir, NOT the bundled templates dir — and any sibling `include(@__DIR__/…)`
// opens a file only present if the deploy step also copied it. #81's first draft added
// `include(joinpath(@__DIR__, "emit_formulation.jl"))` while AGENTS.md copies only the
// template → LoadError before solve!, on every agent-driven run. Nothing in the vitest
// suite executed the template, so it shipped green. This test closes that gap WITHOUT
// needing Julia: it ties the two seams together — reproduce exactly the files AGENTS.md
// copies into scratch, then assert every include() in the deployed script resolves there.
// Stays green under either fix: inline the helper (no include), or teach AGENTS.md to
// copy it too. The deeper guard is #78's smoke corpus actually running a solve.
const EXT = join(__dirname, '..')
const AGENTS = readFileSync(join(EXT, 'AGENTS.md'), 'utf8')
const TEMPLATE = join(EXT, 'templates', 'solve_template.jl')

describe('solve template deploys runnably under AGENTS.md single-file copy [#81]', () => {
  it('every include() in the deployed script resolves in the scratch dir', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'amicode-work-'))

    // Reproduce AGENTS.md's scratch-dir copies: `cp <src> /tmp/amicode-work/<dst>`.
    // {{TEMPLATE_PATH}} is the substitution for the bundled solve_template.jl.
    const copied = new Map<string, string>()   // destName -> srcAbs
    for (const m of AGENTS.matchAll(/\bcp\s+(\S+)\s+(\S+)/g)) {
      const [, srcTok, dst] = m
      if (!dst.includes('amicode-work')) continue
      const srcAbs = srcTok.replace('{{TEMPLATE_PATH}}', TEMPLATE)
      copied.set(dst.endsWith('/') ? basename(srcAbs) : basename(dst), srcAbs)
    }
    expect(copied.size, 'AGENTS.md should document copying the template into the scratch dir').toBeGreaterThan(0)
    for (const [name, srcAbs] of copied) copyFileSync(srcAbs, join(scratch, name))

    // amico-run runs `julia <scratch>/solve.jl`, so @__DIR__ === scratch for the run file.
    const runFile = copied.has('solve.jl') ? 'solve.jl' : [...copied.keys()][0]
    const src = readFileSync(join(scratch, runFile), 'utf8')

    // Julia resolves a relative include (bare or joinpath(@__DIR__, …)) against @__DIR__.
    const unresolved: string[] = []
    for (const m of src.matchAll(/^[ \t]*include\((.+?)\)[ \t]*(?:#.*)?$/gm)) {
      const arg = m[1].trim()
      const sibling =
        arg.match(/^joinpath\(\s*@__DIR__\s*,\s*"([^"]+)"\s*\)$/)?.[1] ??
        arg.match(/^"(?!\/)([^"]+)"$/)?.[1]
      if (sibling === undefined) { unresolved.push(`unclassifiable include(${arg})`); continue }
      if (!existsSync(join(scratch, sibling))) unresolved.push(sibling)
    }
    expect(
      unresolved,
      `deployed template can't resolve include(s): ${unresolved.join(', ')} — inline them, or make AGENTS.md copy them into the scratch dir`,
    ).toEqual([])
  })
})
