// Typed surface of scripts/test_quarantine_gate.mjs for the amico-run test
// suite (its tsconfig includes test/, which imports this script).

export type ListKind = "known-fail" | "known-flaky";

export interface QuarantineEntry {
  id: string;
  issue: number;
  ttl: string | null;
  kind: ListKind;
  line: number;
}

export interface ObservedTest {
  id: string;
  status: "passed" | "failed" | "skipped";
}

export interface GateViolation {
  kind:
    | "new-failure"
    | "known-fail-passed"
    | "known-fail-not-observed"
    | "flaky-ttl-expired"
    | "invalid-entry"
    | "runner-failed-unexplained"
    | "unreadable-report";
  id: string | null;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  suite: string | undefined;
  violations: GateViolation[];
  counts: { total: number; failed: number };
}

export const DEFAULT_LISTS_DIR: string;

export function parseList(text: string, kind: ListKind): { entries: QuarantineEntry[]; errors: string[] };

export function parseResults(text: string, opts?: { suite?: string; root?: string }): { suite: string; tests: ObservedTest[] };

export function evaluateGate(input: {
  suite: string;
  tests: ObservedTest[];
  knownFail: QuarantineEntry[];
  knownFlaky: QuarantineEntry[];
  listErrors?: string[];
  today: string;
  runnerExit?: number;
}): GateResult;

export function runGate(opts: {
  resultFile: string;
  listsDir?: string;
  suite?: string;
  root?: string;
  today?: string;
  runnerExit?: number;
}): GateResult;
