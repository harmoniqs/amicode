// Tests for the amicode_* tool pack's entity layer (opencode-plugin/entities.ts).
//
// entities.ts is deliberately dependency-free (it is imported by the opencode
// plugin, which executes inside opencode's embedded Bun runtime, NOT in the
// extension bundle) — so these tests exercise it as plain functions. Round-trips
// go through `smol-toml`, the SAME parser @amicode/schema and the extension use
// (run_dir_reader.ts, schema/src/index.ts) — what these serializers emit must be
// readable by the validators downstream.
//
// The plugin module itself (amicode_tools.ts) is NOT imported here: it holds a
// module-scope console.log + fs side effects and must keep a single plugin-function
// export (opencode's getLegacyPlugins throws on any extra export). Its runtime
// loading is verified against the real binary (see the night-build handoff), not
// in vitest.
import { describe, it, expect } from 'vitest'
import { parse } from 'smol-toml'
import {
  systemToml,
  formulationToml,
  runStubToml,
  deviceSessionStubToml,
  calibrationStubToml,
  validateSystem,
  validateFormulation,
  updateSystem,
  type SystemEntity,
  type FormulationEntity,
} from '../opencode-plugin/entities'

const SYS: SystemEntity = {
  platform: 'transmon',
  levels: 3,
  params: { omega: 4.8, delta: -0.2 },
}

const FORM: FormulationEntity = {
  problem: 'gate_synthesis',
  target: 'X',
  objective: 'unitary infidelity',
  constraints: ['amplitude bound (drive_max)', 'smoothness'],
}

describe('systemToml', () => {
  it('emits valid TOML that round-trips through smol-toml (the repo parser)', () => {
    const doc = parse(systemToml(SYS)) as any
    expect(doc.system).toBeDefined()                    // [system] header
    expect(doc.system.platform).toBe('transmon')
    expect(doc.system.levels).toBe(3)
    expect(doc.system.params.omega).toBeCloseTo(4.8)
    expect(doc.system.params.delta).toBeCloseTo(-0.2)
  })
  it('stamps an ISO-8601 `recorded` field (quoted string — parseable, no TomlDate surprises)', () => {
    const doc = parse(systemToml(SYS)) as any
    expect(typeof doc.system.recorded).toBe('string')
    expect(Number.isNaN(Date.parse(doc.system.recorded))).toBe(false)
  })
  it('accepts the levels boundary values 2 and 6', () => {
    expect(() => systemToml({ ...SYS, levels: 2 })).not.toThrow()
    expect(() => systemToml({ ...SYS, levels: 6 })).not.toThrow()
  })
  it('rejects an unknown platform', () => {
    expect(() => systemToml({ ...SYS, platform: 'flux-capacitor' as any })).toThrow(/platform/)
  })
  it('rejects levels < 2, > 6, and non-integers', () => {
    expect(() => systemToml({ ...SYS, levels: 1 })).toThrow(/levels/)
    expect(() => systemToml({ ...SYS, levels: 7 })).toThrow(/levels/)
    expect(() => systemToml({ ...SYS, levels: 3.5 })).toThrow(/levels/)
  })
  it('rejects non-finite param values (NaN/Infinity have no TOML representation)', () => {
    expect(() => systemToml({ ...SYS, params: { omega: NaN } })).toThrow(/param/)
    expect(() => systemToml({ ...SYS, params: { omega: Infinity } })).toThrow(/param/)
  })
  it('quotes param keys that are not TOML bare keys', () => {
    const doc = parse(systemToml({ ...SYS, params: { 'drive max': 0.2 } })) as any
    expect(doc.system.params['drive max']).toBeCloseTo(0.2)
  })
})

describe('formulationToml', () => {
  it('round-trips problem/target/objective/constraints under [formulation]', () => {
    const doc = parse(formulationToml(FORM)) as any
    expect(doc.formulation.problem).toBe('gate_synthesis')
    expect(doc.formulation.target).toBe('X')
    expect(doc.formulation.objective).toBe('unitary infidelity')
    expect(doc.formulation.constraints).toEqual(FORM.constraints)
    expect(Number.isNaN(Date.parse(doc.formulation.recorded))).toBe(false)
  })
  it('escapes quotes, backslashes, and newlines in string values (round-trip exact)', () => {
    const nasty = 'say "hi" \\ then\nnewline\ttab'
    const doc = parse(formulationToml({ ...FORM, target: nasty, constraints: [nasty] })) as any
    expect(doc.formulation.target).toBe(nasty)
    expect(doc.formulation.constraints).toEqual([nasty])
  })
  it('rejects an empty or whitespace-only target', () => {
    expect(() => formulationToml({ ...FORM, target: '' })).toThrow(/target/)
    expect(() => formulationToml({ ...FORM, target: '   ' })).toThrow(/target/)
  })
  it('rejects an empty problem', () => {
    expect(() => formulationToml({ ...FORM, problem: '' })).toThrow(/problem/)
  })
})

describe('validateSystem / validateFormulation', () => {
  it('return [] for valid entities', () => {
    expect(validateSystem(SYS)).toEqual([])
    expect(validateFormulation(FORM)).toEqual([])
  })
  it('name the offending field in each problem message', () => {
    expect(validateSystem({ ...SYS, platform: 'nope' as any }).join(' ')).toMatch(/platform/)
    expect(validateSystem({ ...SYS, levels: 99 }).join(' ')).toMatch(/levels/)
    expect(validateFormulation({ ...FORM, target: '' }).join(' ')).toMatch(/target/)
  })
})

describe('updateSystem (the amicode_set_model merge)', () => {
  it('merges levels and params, preserving untouched params and the platform', () => {
    const merged = updateSystem(SYS, { levels: 4, params: { drive_max: 0.2, delta: -0.25 } })
    expect(merged.platform).toBe('transmon')
    expect(merged.levels).toBe(4)
    expect(merged.params.omega).toBeCloseTo(4.8)      // untouched param preserved
    expect(merged.params.delta).toBeCloseTo(-0.25)    // overwritten
    expect(merged.params.drive_max).toBeCloseTo(0.2)  // added
  })
  it('does not mutate the input entity', () => {
    const before = JSON.parse(JSON.stringify(SYS))
    updateSystem(SYS, { levels: 5, params: { omega: 5.1 } })
    expect(SYS).toEqual(before)
  })
  it('leaves levels alone when the patch omits it', () => {
    expect(updateSystem(SYS, { params: { drive_max: 0.3 } }).levels).toBe(3)
  })
  it('throws when the merge would produce an invalid entity', () => {
    expect(() => updateSystem(SYS, { levels: 9 })).toThrow(/levels/)
    expect(() => updateSystem(SYS, { params: { omega: NaN } })).toThrow(/param/)
  })
})

describe('runStubToml (bookkeeping stub — NOT amico-run\'s run.toml)', () => {
  it('round-trips refs + launched_via under [run]', () => {
    const doc = parse(runStubToml({
      formulation_ref: '/home/u/.amico/runs/default/_entities/formulation.toml',
      system_ref: '/home/u/.amico/runs/default/_entities/system.toml',
      run_dir: '/home/u/.amico/runs/default/20260703-021500-abcd',
      note: 'X gate, defaults',
    })) as any
    expect(doc.run.launched_via).toBe('bash amico-run')  // the tool never launches — bash does
    expect(doc.run.formulation_ref).toMatch(/formulation\.toml$/)
    expect(doc.run.system_ref).toMatch(/system\.toml$/)
    expect(doc.run.run_dir).toMatch(/20260703-021500-abcd$/)
    expect(doc.run.note).toBe('X gate, defaults')
    expect(Number.isNaN(Date.parse(doc.run.recorded))).toBe(false)
  })
  it('omits absent optional refs instead of writing empty strings', () => {
    const doc = parse(runStubToml({})) as any
    expect(doc.run.launched_via).toBe('bash amico-run')
    expect('formulation_ref' in doc.run).toBe(false)
    expect('system_ref' in doc.run).toBe(false)
    expect('note' in doc.run).toBe(false)
  })
})

describe('deviceSessionStubToml (stage-8 guided stub — NO device I/O in this build)', () => {
  it('round-trips refs + the fixed gate/checks under [device_session]', () => {
    const doc = parse(deviceSessionStubToml({
      pulse_ref: '/home/u/.amico/runs/default/20260703-021500-abcd/pulse.jld2',
      run_dir: '/home/u/.amico/runs/default/20260703-021500-abcd',
      note: 'X gate pulse, F=0.9999',
    })) as any
    expect(doc.device_session.gate).toBe('pending-human-signoff')  // never auto-approved
    expect(doc.device_session.checks).toEqual([                    // the send-to-device gate's auto checks
      'fidelity>=threshold', '|drive|<=cap', 'bandwidth', 'leakage',
    ])
    expect(doc.device_session.pulse_ref).toMatch(/pulse\.jld2$/)
    expect(doc.device_session.run_dir).toMatch(/20260703-021500-abcd$/)
    expect(doc.device_session.note).toBe('X gate pulse, F=0.9999')
    expect(Number.isNaN(Date.parse(doc.device_session.recorded))).toBe(false)
  })
  it('omits absent optional refs; gate + checks are always present', () => {
    const doc = parse(deviceSessionStubToml({})) as any
    expect(doc.device_session.gate).toBe('pending-human-signoff')
    expect(doc.device_session.checks).toHaveLength(4)
    expect('pulse_ref' in doc.device_session).toBe(false)
    expect('run_dir' in doc.device_session).toBe(false)
    expect('note' in doc.device_session).toBe(false)
  })
  it('rejects given-but-empty refs (a caller bug, not an omission)', () => {
    expect(() => deviceSessionStubToml({ pulse_ref: '' })).toThrow(/pulse_ref/)
    expect(() => deviceSessionStubToml({ run_dir: '   ' })).toThrow(/run_dir/)
  })
})

describe('calibrationStubToml (guided follow-up stub — loop not wired in this build)', () => {
  it('round-trips the ref + fixed loop/status under [calibration]', () => {
    const doc = parse(calibrationStubToml({
      device_session_ref: '/home/u/.amico/runs/default/_entities/device_session.toml',
      note: 'after first hardware shots',
    })) as any
    expect(doc.calibration.loop).toBe('ILC')          // the loop that follows hardware runs
    expect(doc.calibration.status).toBe('not-wired')  // honest: recorded follow-up only tonight
    expect(doc.calibration.device_session_ref).toMatch(/device_session\.toml$/)
    expect(doc.calibration.note).toBe('after first hardware shots')
    expect(Number.isNaN(Date.parse(doc.calibration.recorded))).toBe(false)
  })
  it('omits absent optionals; loop + status are always present', () => {
    const doc = parse(calibrationStubToml({})) as any
    expect(doc.calibration.loop).toBe('ILC')
    expect(doc.calibration.status).toBe('not-wired')
    expect('device_session_ref' in doc.calibration).toBe(false)
    expect('note' in doc.calibration).toBe(false)
  })
  it('rejects a given-but-empty device_session_ref', () => {
    expect(() => calibrationStubToml({ device_session_ref: '' })).toThrow(/device_session_ref/)
  })
})
