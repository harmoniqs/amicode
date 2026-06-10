import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpRoot, readToml } from '../helpers.js'
import { validateManifest, validateFinished, validateResult } from '../../src/schemas.js'

// Slow tier (spec §8): real Piccolo solves through the real CLI. Dev machine only — not CI.
// Requires: julia on PATH + a Piccolo project (pass via AMICO_TEST_JULIA_PROJECT to *the test*,
// which forwards it as an explicit --project flag — the orchestrator itself stays env-free).
const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT
const BUNDLE = join(__dirname, '..', '..', 'dist', 'amico-run.js')

function solveAndValidate(script: string): void {
  const root = tmpRoot()
  const stdout = execFileSync('node', [
    BUNDLE, join(__dirname, script),
    '--runs-root', join(root, 'runs'), '--project', PROJECT!, '--lab', 'devlab',
  ], { encoding: 'utf8', timeout: 600_000 })

  expect(stdout).toMatch(/AMICODE_ITER iter=/)
  expect(stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=(.+)/)
  const runDir = stdout.match(/runDir=(.+)/)![1].trim()
  expect(validateManifest(readToml(join(runDir, 'manifest.toml'))).ok).toBe(true)
  expect(validateFinished(readToml(join(runDir, 'FINISHED'))).ok).toBe(true)
  const result = readToml(join(runDir, 'result.toml'))
  expect(validateResult(result).ok).toBe(true)
  expect(result.fidelity as number).toBeGreaterThan(0.99)
}

describe.skipIf(!PROJECT)('slow: real Piccolo solves through amico-run', () => {
  it('x-gate solve produces a fully conforming run dir', () => {
    solveAndValidate('solve_x_gate.jl')
  }, 600_000)

  it('h-gate solve produces a fully conforming run dir', () => {
    solveAndValidate('solve_h_gate.jl')
  }, 600_000)
})
