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
  // amicode_* plugin (Bun-transpiled .ts, loaded by absolute path) — every sibling
  // is load-bearing: a dropped file silently reverts the session to vanilla opencode.
  'extension/opencode-plugin/amicode_tools.ts',
  'extension/opencode-plugin/entities.ts',
  'extension/opencode-plugin/problems.ts',
  'extension/opencode-plugin/hashes.ts',
  'extension/opencode-plugin/score_guard.ts',
]

// Guards against a silently-dropped runtime asset (the β.2 .gitignore-fallback
// trap, generalized). Locally: inert without a built .vsix (run after
// `pnpm --filter amicode-v2 package`) so the fast suite stays green. In CI: the
// vsix-gate job (#45) sets AMICODE_REQUIRE_VSIX=1, under which the suite can
// NEVER self-skip — a missing .vsix is a hard failure there, closing the
// perennial "2 skip" false-green.
const REQUIRE_VSIX = process.env.AMICODE_REQUIRE_VSIX === '1'
describe.skipIf(!existsSync(VSIX) && !REQUIRE_VSIX)('packaged VSIX contains runtime assets', () => {
  it('the .vsix exists (hard requirement under AMICODE_REQUIRE_VSIX=1)', () => {
    expect(existsSync(VSIX), `no ${VSIX} — run: pnpm --filter amicode-v2 package`).toBe(true)
  })
  it('includes amico-run, template, julia project, AGENTS.md + a vendored opencode', () => {
    const listing = execFileSync('unzip', ['-Z1', VSIX], { encoding: 'utf8' })
    for (const p of REQUIRED) expect(listing, `missing ${p}`).toContain(p)
    expect(/extension\/vendor\/opencode\/.+\/opencode/.test(listing), 'missing vendored opencode').toBe(true)
  })
})
