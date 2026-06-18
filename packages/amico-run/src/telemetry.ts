import type { RunEvent } from './types.js'

export function classifyLine(line: string, stream: 'stdout' | 'stderr'): RunEvent {
  if (stream === 'stdout' && line.startsWith('AMICODE_ITER')) {
    const fields: Record<string, string> = {}
    for (const tok of line.slice('AMICODE_ITER'.length).trim().split(/\s+/)) {
      const eq = tok.indexOf('=')
      if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1)
    }
    return { kind: 'iter', raw: line, fields }
  }
  if (stream === 'stdout' && /^DONE(\s|$)/.test(line)) return { kind: 'done', raw: line }
  return { kind: 'log', stream, line }
}
