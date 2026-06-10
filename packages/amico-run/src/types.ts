export type RunStatus = 'completed' | 'failed' | 'aborted'

export interface JuliaOpts {
  julia?: string      // julia binary path; default "julia" from PATH
  project?: string    // --project=<path>
  sysimage?: string   // --sysimage=<path>
}

export interface SubmitOpts {
  lab?: string        // lab POINTER (id or lab.toml path), passed through verbatim; default "default"
  runsRoot?: string   // default: ~/.amico/runs/<lab-id>/
  julia?: JuliaOpts
  graceMs?: number    // abort SIGTERM→SIGKILL grace; default 5000. Test knob, NOT exposed in the CLI.
}

export type RunEvent =
  | { kind: 'iter'; raw: string; fields: Record<string, string> }
  | { kind: 'done'; raw: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'finished'; status: RunStatus; exitCode: number }

export interface Finished { status: RunStatus; exitCode: number }

export interface RunHandle {
  runId: string
  runDir: string
  events: AsyncIterable<RunEvent>          // terminates after the 'finished' event
  finished: Promise<Finished>              // never rejects
  abort(): Promise<void>                   // idempotent
}

export interface Executor {
  submit(scriptPath: string, opts?: SubmitOpts): Promise<RunHandle>
}

/** Exit-64-class fault: bad config, nothing solver-related ran. */
export class ConfigError extends Error {}
