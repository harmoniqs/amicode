import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { prepareOpencodeProject, resolveJuliaProject, buildOpencodeConfigContent } from '../src/opencode_config'

function fakeExtRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'extroot-'))
  writeFileSync(join(root, 'AGENTS.md'), '# A\nproject: {{JULIA_PROJECT}}\ntemplate: {{TEMPLATE_PATH}}\n')
  mkdirSync(join(root, 'templates'))
  writeFileSync(join(root, 'templates', 'solve_template.jl'), '# template\n')
  return root
}

describe('resolveJuliaProject', () => {
  const def = join(homedir(), '.amico', 'julia')
  it('defaults to ~/.amico/julia when empty or whitespace', () => {
    expect(resolveJuliaProject('')).toBe(def)
    expect(resolveJuliaProject('   ')).toBe(def)
  })
  it('uses a configured value, trimmed', () => {
    expect(resolveJuliaProject('/opt/piccolo')).toBe('/opt/piccolo')
    expect(resolveJuliaProject('  /opt/p  ')).toBe('/opt/p')
  })
  it('expands a leading ~ (parity with resolveRunsRoot)', () => {
    expect(resolveJuliaProject('~')).toBe(homedir())
    expect(resolveJuliaProject('~/foo/bar')).toBe(join(homedir(), 'foo', 'bar'))
  })
})

describe('buildOpencodeConfigContent', () => {
  it('emits valid JSON whose instructions points at the (absolute) agents file', () => {
    const cfg = JSON.parse(buildOpencodeConfigContent('/abs/AGENTS.md'))
    expect(cfg.instructions).toEqual(['/abs/AGENTS.md'])
  })
  it('auto-allows the permissions the solve workflow needs (no external_directory hang)', () => {
    const cfg = JSON.parse(buildOpencodeConfigContent('/abs/AGENTS.md'))
    expect(cfg.permission.external_directory).toBe('allow')  // reads the bundled template + /tmp scratch
    expect(cfg.permission.bash).toBe('allow')                // runs amico-run
    expect(cfg.permission.edit).toBe('allow')                // writes solve.jl
  })
})

describe('prepareOpencodeProject', () => {
  it('substitutes the julia project AND the absolute template path, leaving no placeholders', () => {
    const ext = fakeExtRoot()
    const templateSrc = join(ext, 'templates', 'solve_template.jl')
    const p = prepareOpencodeProject({ agentsSrc: join(ext, 'AGENTS.md'), templateSrc, juliaProject: '/opt/piccolo' })
    const agents = readFileSync(p.agentsPath, 'utf8')
    expect(agents).toContain('/opt/piccolo')
    expect(agents).toContain(templateSrc)          // {{TEMPLATE_PATH}} → the absolute bundled template
    expect(agents).not.toMatch(/\{\{.*?\}\}/)      // no residual placeholders
    expect(p.templatePath).toBe(templateSrc)       // points at the bundled source, not a copy
  })
  it('does NOT copy the template or write a vestigial .opencode/opencode.json into the session dir', () => {
    const ext = fakeExtRoot()
    const p = prepareOpencodeProject({ agentsSrc: join(ext, 'AGENTS.md'),
      templateSrc: join(ext, 'templates', 'solve_template.jl'), juliaProject: '/opt/piccolo' })
    expect(existsSync(join(p.projectDir, 'solve_template.jl'))).toBe(false)
    expect(existsSync(join(p.projectDir, '.opencode', 'opencode.json'))).toBe(false)
  })
})
