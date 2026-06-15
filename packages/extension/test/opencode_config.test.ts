import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOpencodeProject } from '../src/opencode_config'

function fakeExtRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'extroot-'))
  writeFileSync(join(root, 'AGENTS.md'), '# A\nproject: {{JULIA_PROJECT}}\n')
  mkdirSync(join(root, 'templates'))
  writeFileSync(join(root, 'templates', 'solve_template.jl'), '# template\n')
  return root
}

describe('prepareOpencodeProject', () => {
  it('copies AGENTS.md + template into the session and substitutes the julia project', () => {
    const ext = fakeExtRoot()
    const p = prepareOpencodeProject({
      agentsSrc: join(ext, 'AGENTS.md'),
      templateSrc: join(ext, 'templates', 'solve_template.jl'),
      juliaProject: '/opt/piccolo',
    })
    expect(existsSync(join(p.projectDir, 'solve_template.jl'))).toBe(true)
    const agents = readFileSync(p.agentsPath, 'utf8')
    expect(agents).toContain('/opt/piccolo')
    expect(agents).not.toContain('{{JULIA_PROJECT}}')
  })
  it('substitutes UNSET when no project configured', () => {
    const ext = fakeExtRoot()
    const p = prepareOpencodeProject({ agentsSrc: join(ext, 'AGENTS.md'),
      templateSrc: join(ext, 'templates', 'solve_template.jl'), juliaProject: undefined })
    expect(readFileSync(p.agentsPath, 'utf8')).toContain('UNSET')
  })
})
