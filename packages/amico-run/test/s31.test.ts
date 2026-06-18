import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// S31 / spec §4: no physics flag parsing, no SolveSpec, no MCP, no HTTP in the orchestrator.
const FORBIDDEN = [/SolveSpec/, /--gate\b/, /--system\b/, /--pulse\b/,
                   /modelcontextprotocol/i, /node:https?\b/, /\bfetch\s*\(/]

describe('S31 grep rule', () => {
  it('src/ contains no forbidden tool-layer patterns', () => {
    const srcDir = join(__dirname, '..', 'src')
    for (const f of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, f), 'utf8')
      for (const re of FORBIDDEN) {
        expect(text, `${f} matches forbidden ${re}`).not.toMatch(re)
      }
    }
  })
})
