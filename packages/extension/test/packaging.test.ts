import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const VSIX = join(__dirname, '..', 'amicode.vsix')
const REQUIRED = [
  'extension/bin/dist/amico-run.js',
  'extension/bin/launcher/amico-run',
  'extension/templates/solve_template.jl',
  'extension/julia/Project.toml',
  'extension/julia/Manifest.toml',
  'extension/AGENTS.md',
  'extension/demo/run/run.toml',
  'extension/demo/run/FINISHED',
  'extension/demo/run/run.log',   // inspector reads run.log for the demo's stats row; *.log-gitignored so easy to drop
  'extension/media/brand.css',      // style variables (design-owned) — must ship, else an unstyled inspector
  'extension/media/layout.css',     // layout selectors (design-owned) — must ship, else an unstyled inspector
  'extension/scores/pulse-designer/SCORE.md',            // score #0 — the interview is data; a dropped repertoire = silent prose fallback
  'extension/scores/pulse-designer/templates/solve.jl',  // score-local vetted template (lint requires it resolves)
  'extension/scores/memory/free-phase-objective-only.md',
  'extension/scores/entitlements.toml',                  // entitlement registry — gating breaks silently without it
]

// Guards against a silently-dropped runtime asset (the β.2 .gitignore-fallback
// trap, generalized). Inert without a built .vsix so CI stays green; run after
// `pnpm --filter amicode-v2 package`.
describe.skipIf(!existsSync(VSIX))('packaged VSIX contains runtime assets', () => {
  it('includes amico-run, template, julia project, AGENTS.md + a vendored opencode', () => {
    const listing = execFileSync('unzip', ['-Z1', VSIX], { encoding: 'utf8' })
    for (const p of REQUIRED) expect(listing, `missing ${p}`).toContain(p)
    expect(/extension\/vendor\/opencode\/.+\/opencode/.test(listing), 'missing vendored opencode').toBe(true)
  })
})
