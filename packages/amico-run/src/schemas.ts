// PROVISIONAL shapes — superseded by Phase 0' SchemaPackage (plan task 0.1).
// Field names here ARE the contract and must survive that migration (spec §7).
export interface Validation { ok: boolean; errors: string[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function check(errors: string[], cond: boolean, path: string, want: string): void {
  if (!cond) errors.push(`${path}: expected ${want}`)
}

export function validateManifest(v: unknown): Validation {
  const errors: string[] = []
  if (!isObj(v)) return { ok: false, errors: ['manifest: expected table'] }
  check(errors, v.schema_version === '1', 'schema_version', '"1"')
  for (const k of ['run_id', 'script_path', 'lab', 'lab_id', 'created_at', 'orchestrator_version'])
    check(errors, typeof v[k] === 'string' && (v[k] as string).length > 0, k, 'non-empty string')
  check(errors, isObj(v.julia), 'julia', 'table')
  if (isObj(v.julia)) {
    check(errors, typeof v.julia.binary === 'string', 'julia.binary', 'string')
    for (const k of ['project', 'sysimage'] as const)
      check(errors, v.julia[k] === undefined || typeof v.julia[k] === 'string', `julia.${k}`, 'string if present')
  }
  return { ok: errors.length === 0, errors }
}

export function validateFinished(v: unknown): Validation {
  const errors: string[] = []
  if (!isObj(v)) return { ok: false, errors: ['FINISHED: expected table'] }
  check(errors, v.status === 'completed' || v.status === 'failed' || v.status === 'aborted',
        'status', 'completed|failed|aborted')
  check(errors, Number.isInteger(v.exit_code), 'exit_code', 'integer')
  return { ok: errors.length === 0, errors }
}

export function validateResult(v: unknown): Validation {
  const errors: string[] = []
  if (!isObj(v)) return { ok: false, errors: ['result: expected table'] }
  check(errors, typeof v.fidelity === 'number', 'fidelity', 'number')
  check(errors, Number.isInteger(v.iterations), 'iterations', 'integer')
  return { ok: errors.length === 0, errors }
}
