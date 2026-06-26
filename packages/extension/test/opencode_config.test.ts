import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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
})

describe('buildOpencodeConfigContent', () => {
  const TPL = '/ext/templates/solve_template.jl'
  it('emits valid JSON whose instructions points at the (absolute) agents file', () => {
    const cfg = JSON.parse(buildOpencodeConfigContent('/abs/AGENTS.md', TPL))
    expect(cfg.instructions).toEqual(['/abs/AGENTS.md'])
  })
  it('scopes external_directory to the template + scratch roots (least privilege), drops webfetch', () => {
    const cfg = JSON.parse(buildOpencodeConfigContent('/abs/AGENTS.md', TPL))
    const ed = cfg.permission.external_directory
    expect(typeof ed).toBe('object')                          // path-scoped, NOT a blanket "allow"
    expect(ed[TPL]).toBe('allow')                             // the template file the agent reads
    expect(ed['/ext/templates/**']).toBe('allow')            // its dir (belt-and-suspenders)
    expect(ed['/tmp/amicode-work/**']).toBe('allow')         // scratch it writes solve.jl into
    expect(ed['/private/tmp/amicode-work/**']).toBe('allow') // macOS: /tmp → /private/tmp
    expect(cfg.permission.bash).toBe('allow')                 // runs amico-run (compound launch)
    expect(cfg.permission.edit).toBe('allow')                 // fills the FILL-IN block
    expect(cfg.permission.webfetch).toBeUndefined()           // unused by the solve flow — dropped
  })
})

// Integration: confirms opencode 1.17.3 DEEP-merges the injected `permission`
// object over the user's global config rather than shallow-replacing it (which
// would wipe the user's other permission keys). Skipped when the vendored binary
// isn't present (e.g. minimal CI before `fetch:opencode`).
const OC_BIN = join(__dirname, '..', 'vendor', 'opencode', `${process.platform}-${process.arch}`, 'opencode')
describe.skipIf(!existsSync(OC_BIN))('opencode permission merge (1.17.3)', () => {
  it('injected permission ADDS keys — the user\'s global permission keys survive', () => {
    const home = mkdtempSync(join(tmpdir(), 'ochome-'))
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ permission: { doom_loop: 'deny' } }))   // a distinctive user-set key
    const out = execFileSync(OC_BIN, ['debug', 'config'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
             OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent('/abs/AGENTS.md', '/ext/templates/solve_template.jl') },
    })
    const cfg = JSON.parse(out)
    expect(cfg.permission.doom_loop).toBe('deny')                   // user's key SURVIVED the deep-merge
    expect(typeof cfg.permission.external_directory).toBe('object') // our injected key is present too
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
