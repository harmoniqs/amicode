import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENTS = readFileSync(join(__dirname, '..', 'AGENTS.md'), 'utf8')

describe('AGENTS.md teaches the D9/D10 script-authoring workflow', () => {
  it('points at the bundled template and the amico-run <script> invocation', () => {
    expect(AGENTS).toMatch(/solve_template\.jl/)
    expect(AGENTS).toMatch(/amico-run .*solve\.jl/)   // the actual invocation it teaches
  })
  it('teaches the portable detached launch (nohup + & in a subshell + watch inspector), not setsid', () => {
    expect(AGENTS).toMatch(/nohup/)
    expect(AGENTS).toMatch(/&\s*\)/)              // backgrounded inside a subshell
    expect(AGENTS).toMatch(/Run Inspector/)
    expect(AGENTS).not.toMatch(/setsid/)          // Linux-only; would silently break the macOS demo
  })
  it('does not tell the agent to block on the solve', () => {
    expect(AGENTS).not.toMatch(/wait for (the )?solve to finish/i)
  })
  it('documents the run-dir contract the script must emit', () => {
    expect(AGENTS).toMatch(/AMICODE_ITER/)
    expect(AGENTS).toMatch(/iter_.*\.png/)
    expect(AGENTS).toMatch(/result\.toml/)
    expect(AGENTS).toMatch(/load_traj/)            // corrected warm-start idiom (not load_pulse)
  })
  it('does NOT teach the deleted pre-D9 flag CLI', () => {
    expect(AGENTS).not.toMatch(/--gate\b/)
    expect(AGENTS).not.toMatch(/--system\b/)
    expect(AGENTS).not.toMatch(/load_pulse/)
  })
})
