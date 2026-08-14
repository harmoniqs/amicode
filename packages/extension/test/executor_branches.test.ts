// packages/extension/test/executor_branches.test.ts
// S12 structural pin (Track C locked decisions, Δ8 AC): downstream consumes
// ONLY the RunHandle / run-dir contract — no executor-type branches anywhere
// in the runs/inspector pipeline. Comments stripped: prose may name them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILES = [
  "runs_manager.ts",
  "run_registry.ts",
  "inspector_bridge.ts",
  "run_dir_reader.ts",
  "run_controls.ts",
  "status_bar.ts",
];

describe("S12 — no executor-type branches in the runs/inspector pipeline", () => {
  for (const f of FILES) {
    it(`${f} names no executor type in code`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src).not.toMatch(/LocalExecutor|RemoteExecutor|instanceof\s+\w*Executor/);
    });
  }
});
