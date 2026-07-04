import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENTS = readFileSync(join(__dirname, '..', 'AGENTS.md'), 'utf8')

describe('AGENTS.md teaches the D9/D10 script-authoring workflow', () => {
  it('teaches the tiered resolve → author → --spec launch (spec C), not a single bundled template', () => {
    expect(AGENTS).toMatch(/amico-run resolve/)   // tier resolution step
    expect(AGENTS).toMatch(/amico-run --spec/)    // the gated invocation it teaches
    expect(AGENTS).toMatch(/solve\.jl/)
    expect(AGENTS).toMatch(/vetted/)                       // the three tiers named
    expect(AGENTS).toMatch(/composed/)
    expect(AGENTS).toMatch(/free/)
  })
  it('authors into the workspace-owned solve.jl (spec A), never /tmp', () => {
    expect(AGENTS).toMatch(/~\/\.amico\/problems\/<slug>\/solve\.jl/)  // workspace-owned
    expect(AGENTS).not.toMatch(/\/tmp\/amicode-work/)                  // the old scratch path is gone
    expect(AGENTS).not.toMatch(/in this project dir/)
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
  it('author-first: multi-qubit transmon ROUTES to the free-tier offer (unvetted, verified), never a flat decline', () => {
    expect(AGENTS).toMatch(/single[- ]qubit/i)
    expect(AGENTS).toMatch(/multi-qubit|two-qubit|2-qubit|CNOT/i)
    // spec-20260704-113005 §5: "no template → decline" is retired — it routes to
    // the free-tier offer with an honest unvetted caveat, not a stop.
    expect(AGENTS).toMatch(/free[- ]tier/i)
    expect(AGENTS).toMatch(/unvetted/i)
    expect(AGENTS).not.toMatch(/say so plainly and stop/i)
    // the reconciliation: 2-qubit Rydberg CZ IS supported (composed exemplar / Piccolissimo path).
    // whitespace-tolerant: markdown reflow may wrap any gap in the phrase.
    expect(AGENTS).toMatch(/Rydberg\s+CZ\s+is\s+the\s+exception/i)
  })
  it('author-first PLATFORM intake: no coercion, records the actual platform, offers free-tier (spec §5)', () => {
    expect(AGENTS).toMatch(/as stated/i)                     // acknowledge the platform as itself
    expect(AGENTS).toMatch(/actual platform string/i)        // record the real string, not "other"
    expect(AGENTS).toMatch(/never coerce/i)
    expect(AGENTS).toMatch(/## Skill index/)                 // routing keys off the dual-source index
    expect(AGENTS).toMatch(/free-phase CZ path/i)            // the issimo Piccolissimo recommendation
  })
  it('gives regime guidance (level cap + scale N with gate time)', () => {
    expect(AGENTS).toMatch(/levels/i)
    expect(AGENTS).toMatch(/steps\/ns|timesteps/i)
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

describe('AGENTS.md pulse-designer interview (Layer 0)', () => {
  it('scopes the interview to the pulse-designer persona and never forces it on a specific ask', () => {
    expect(AGENTS).toMatch(/pulse-designer/)
    expect(AGENTS).toMatch(/skip straight to\s+the\s+workflow/i)
    expect(AGENTS).toMatch(/fast-forward/i)
  })
  it('capabilities question has a curated answer: no webfetch, no engine talk', () => {
    expect(AGENTS).toMatch(/## Answering "What can Amicode do\?"/)
    expect(AGENTS).toMatch(/never webfetch/i)
    expect(AGENTS).toMatch(/never describe the underlying engine/i)
    expect(AGENTS).toMatch(/How I work \(author-first\)/)   // the curated scope statement (renamed from "Today's scope" in §5)
  })
  it('identity: Amico/Amicode, never self-describes as opencode; interview kicks off proactively on greetings', () => {
    expect(AGENTS).toMatch(/You are \*\*Amico\*\*/)
    expect(AGENTS).toMatch(/NOT "opencode"/)
    expect(AGENTS).toMatch(/never describe yourself as an interactive CLI tool/i)
    expect(AGENTS).toMatch(/\*\*proactively\*\*/i)
    expect(AGENTS).toMatch(/greeting or no specific request/i)
  })
  it('enforces one-question-at-a-time cadence', () => {
    expect(AGENTS).toMatch(/ONE question at a time/)
    expect(AGENTS).toMatch(/Never batch/i)
  })
  it('walks the stage chain in order', () => {
    const stages = ['PLATFORM', 'MODEL', 'MODE', 'PROBLEM', 'FORMULATION', 'SOLVE PARAMS', 'INSPECT', 'HARDWARE / CALIBRATE']
    // Match the bold stage markers — bare indexOf collides on prefixes (MODE ⊂ MODEL).
    const idx = stages.map((s) => AGENTS.indexOf(`**${s}**`))
    idx.forEach((i, k) => expect(i, `stage ${stages[k]} present`).toBeGreaterThan(-1))
    for (let k = 1; k < idx.length; k++) expect(idx[k], `${stages[k]} after ${stages[k - 1]}`).toBeGreaterThan(idx[k - 1])
  })
  it('shows the transmon Hamiltonian in LaTeX and is honest about the Rydberg tier', () => {
    expect(AGENTS).toContain('\\hat H/\\hbar')
    expect(AGENTS).toMatch(/rydberg/i)
    // Rydberg authoring IS wired (composed tier, experimental) — the stale
    // "not wired / transmon-only follow-up" narrative must stay gone.
    expect(AGENTS).toMatch(/composed/i)
    expect(AGENTS).toMatch(/experimental/i)
    expect(AGENTS).not.toMatch(/Rydberg solve authoring is not wired/i)
  })
  it('names the amicode_* recording tools as bookkeeping, not gates, with bash still the launch mechanism', () => {
    for (const t of [
      'amicode_ask',
      'amicode_pick_system',
      'amicode_set_model',
      'amicode_formulate',
      'amicode_solve',
      'amicode_to_hardware',
      'amicode_calibrate',
    ]) {
      expect(AGENTS).toContain(t)
    }
    expect(AGENTS).toMatch(/bookkeeping, not gates/)
    expect(AGENTS).toMatch(/they never replace the bash launch/i)
  })
  it('teaches the free-tier verification recording (amicode_verify) and untrusted-until-agree rule', () => {
    expect(AGENTS).toContain('amicode_verify')
    expect(AGENTS).toMatch(/verification\.toml/)
    expect(AGENTS).toMatch(/cannot be promoted[\s\S]*until verification/i)
  })
  it('keeps the guardrails: T-vs-N convention and no silent global co-optimization', () => {
    expect(AGENTS).toMatch(/`T` = scalar gate time/)
    expect(AGENTS).toMatch(/`N` = number of timesteps/)
    expect(AGENTS).toMatch(/Never silently\s+co-optimize/i)
  })
  it('leaves no unknown {{...}} placeholder after session-prep substitution', () => {
    const substituted = AGENTS.replace(/\{\{TEMPLATE_PATH\}\}/g, '/abs/solve_template.jl').replace(
      /\{\{JULIA_PROJECT\}\}/g,
      '/abs/julia',
    )
    expect(substituted).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })
})
