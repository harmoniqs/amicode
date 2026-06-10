import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LocalExecutor } from './local_executor.js'
import { ConfigError, type Finished, type SubmitOpts } from './types.js'

const USAGE = `usage: amico-run <script.jl> [--executor local] [--lab <id-or-path>]
                 [--runs-root <path>] [--julia <path>] [--project <path>] [--sysimage <path>]`

export async function main(argv: string[]): Promise<number> {
  let script: string | undefined
  let executor = 'local'
  const opts: SubmitOpts = { julia: {} }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new ConfigError(`flag ${a} requires a value`)
      return v
    }
    try {
      switch (a) {
        case '--help': case '-h': console.log(USAGE); return 0
        case '--executor': executor = next(); break
        case '--lab': opts.lab = next(); break
        case '--runs-root': opts.runsRoot = next(); break
        case '--julia': opts.julia!.julia = next(); break
        case '--project': opts.julia!.project = next(); break
        case '--sysimage': opts.julia!.sysimage = next(); break
        default:
          if (a.startsWith('-')) { console.error(`amico-run: unknown flag ${a}\n${USAGE}`); return 64 }
          if (script) { console.error(`amico-run: multiple scripts given`); return 64 }
          script = a
      }
    } catch (e) {
      if (e instanceof ConfigError) { console.error(`amico-run: ${e.message}`); return 64 }
      throw e
    }
  }
  if (!script) { console.error(`amico-run: no script given\n${USAGE}`); return 64 }
  if (executor !== 'local') { console.error(`amico-run: only --executor local is supported in β`); return 64 }

  let handle
  try {
    handle = await new LocalExecutor().submit(script, opts)
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`amico-run: ${e.message}`); return 64 }
    throw e
  }

  const onSignal = (): void => { void handle.abort() }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let fin: Finished | undefined
  for await (const ev of handle.events) {
    if (ev.kind === 'iter' || ev.kind === 'done') console.log(ev.raw)
    else if (ev.kind === 'log') console.log(ev.line)
    else fin = { status: ev.status, exitCode: ev.exitCode }
  }
  const f = fin ?? await handle.finished

  // FINISHED-write failure lane (spec §6 last row): verdict file must exist on disk
  if (!existsSync(join(handle.runDir, 'FINISHED'))) {
    console.error(`amico-run: FINISHED missing in ${handle.runDir} (write fault)`)
    return 64
  }
  // stdout protocol line — camelCase by design (spec §4)
  console.log(`AMICODE_FINISHED status=${f.status} exitCode=${f.exitCode} runDir=${handle.runDir}`)
  if (f.status === 'aborted') return 130
  if (f.status === 'completed') return 0
  return f.exitCode === 0 ? 1 : f.exitCode
}

main(process.argv.slice(2)).then(c => { process.exitCode = c })
