import * as fs from "node:fs";
import * as path from "node:path";

// Usage capture (spec §8: "usage is the design input"). v1 captures, does not learn:
// append-only JSONL per session, timestamps supplied by the caller. This is the
// decision→outcome substrate the learned-traversal work consumes later.

export type UsageEvent =
  | { kind: "session_started"; ts: string; score_id: string; score_version: number }
  | { kind: "stage_entered"; ts: string; stage: string }
  | { kind: "stage_completed"; ts: string; stage: string }
  | { kind: "question_answered"; ts: string; stage: string; question_id: string; default_taken: boolean }
  | { kind: "off_path"; ts: string; from_stage: string }
  | { kind: "gate"; ts: string; gate: string; result: "pass" | "fail" | "override"; override_reason?: string }
  | { kind: "resumed"; ts: string; stage: string };

const FILE = "usage.jsonl";

export function appendUsage(dir: string, event: UsageEvent): void {
  fs.appendFileSync(path.join(dir, FILE), JSON.stringify(event) + "\n");
}

export function readUsage(dir: string): UsageEvent[] {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return [];
  const events: UsageEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as UsageEvent);
    } catch {
      // torn trailing write — tolerate, the funnel skeleton survives
    }
  }
  return events;
}

export interface Traversal {
  score_id: string;
  score_version: number;
  funnel: { stage: string; entered: boolean; completed: boolean }[];
  off_path_count: number;
  defaults_taken: number;
  questions_answered: number;
  gates: { gate: string; result: string }[];
}

export function reconstructTraversal(events: UsageEvent[]): Traversal {
  const t: Traversal = {
    score_id: "",
    score_version: 0,
    funnel: [],
    off_path_count: 0,
    defaults_taken: 0,
    questions_answered: 0,
    gates: [],
  };
  const byStage = new Map<string, { stage: string; entered: boolean; completed: boolean }>();
  for (const e of events) {
    switch (e.kind) {
      case "session_started":
        t.score_id = e.score_id;
        t.score_version = e.score_version;
        break;
      case "stage_entered": {
        if (!byStage.has(e.stage)) {
          const row = { stage: e.stage, entered: true, completed: false };
          byStage.set(e.stage, row);
          t.funnel.push(row);
        }
        break;
      }
      case "stage_completed": {
        const row = byStage.get(e.stage);
        if (row) row.completed = true;
        break;
      }
      case "question_answered":
        t.questions_answered += 1;
        if (e.default_taken) t.defaults_taken += 1;
        break;
      case "off_path":
        t.off_path_count += 1;
        break;
      case "gate":
        t.gates.push({ gate: e.gate, result: e.result });
        break;
      case "resumed":
        break;
    }
  }
  return t;
}
