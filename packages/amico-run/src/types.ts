export type RunStatus = "completed" | "failed" | "aborted";

export interface JuliaOpts {
  julia?: string; // julia binary path; default "julia" from PATH
  project?: string; // --project=<path>
  sysimage?: string; // --sysimage=<path>
}

export interface SubmitOpts {
  lab?: string; // lab POINTER (id or lab.toml path), passed through verbatim; default "default"
  runsRoot?: string; // default: ~/.amico/runs/<lab-id>/
  julia?: JuliaOpts;
  graceMs?: number; // abort SIGTERM→SIGKILL grace; default 5000. Test knob, NOT exposed in the CLI.
  spec?: SpecStamp; // spec C: gate-passed SolveSpec → solvespec.json persisted + run.toml v2 stamped
}

/** What a gate-passed --spec launch carries into the run dir (spec C). */
export interface SpecStamp {
  canonical: string; // stable-key-order solvespec.json body
  tier?: string;
  hashes?: Record<string, string>; // incl. gate-computed spec_hash
  julia_binary?: string; // resolved julia bin — the free-tier verify harness runs under it
  env_project?: string; // resolved env project — --project for the harness
  // solvespec v4: a typed Piccolo ProblemSpec (path string OR inline object). When
  // present, the executor routes to Piccolo.Specs.solve_spec instead of running a
  // script — an object is serialized to <runDir>/problem.toml first, a path is
  // passed straight through. The solvespec schema enforces problem_spec XOR
  // script_path, so exactly one of {scriptPath arg, this} drives a submit().
  problem_spec?: string | Record<string, unknown>;
}

export type RunEvent =
  | { kind: "iter"; raw: string; fields: Record<string, string> }
  | { kind: "done"; raw: string }
  | { kind: "log"; stream: "stdout" | "stderr"; line: string }
  | { kind: "finished"; status: RunStatus; exitCode: number };

export interface Finished {
  status: RunStatus;
  exitCode: number;
}

export interface RunHandle {
  runId: string;
  runDir: string;
  events: AsyncIterable<RunEvent>; // terminates after the 'finished' event
  finished: Promise<Finished>; // never rejects
  abort(): Promise<void>; // idempotent
}

export interface Executor {
  // scriptPath is optional: a v4 solvespec carrying opts.spec.problem_spec has no
  // script — the executor routes it to Piccolo.Specs.solve_spec instead.
  submit(scriptPath: string | undefined, opts?: SubmitOpts): Promise<RunHandle>;
}

/** Exit-64-class fault: bad config, nothing solver-related ran. */
export class ConfigError extends Error {}
