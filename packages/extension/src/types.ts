// Shared types used across extension / mcp / plugin / webview bundles.

/** Action payloads the callback HTTP server accepts from plugin / amico-mcp. */
export type ExtensionAction =
  | { kind: "open-file"; path: string; preview?: boolean; viewColumn?: "active" | "beside" }
  | { kind: "show-notification"; level: "info" | "warn" | "error"; message: string }
  | { kind: "refresh-tree"; tree: "vault" | "catalog" | "armonia" }
  | { kind: "show-quick-pick"; question: string; choices: string[]; replyTo: string }
  | { kind: "run-state"; state: "starting" | "running" | "completed" | "failed"; runId: string; outputDir: string }
  | { kind: "open-inspector" };

/** Quick-pick response shape (POSTed back to plugin once user picks). */
export interface QuickPickReply {
  replyTo: string;
  choice: string | null;
}

/** Terminal + in-flight run statuses. */
export type RunStatus = "starting" | "running" | "completed" | "failed" | "aborted";

/** Solve run state tracked by the extension. */
export interface RunState {
  runId: string;
  outputDir: string;
  startedAt: number;
  status: RunStatus;
  latestIter?: number;
  fidelity?: number;
}

/** Parsed AMICODE_ITER line from spike_solve.jl stdout. */
export interface SolverIterRecord {
  iter: number;
  f_val: number;
  inf_pr: number;
  inf_du: number;
}
