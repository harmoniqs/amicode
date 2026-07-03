import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkStagePrereqs,
  loadManifest,
  loadScoreState,
  saveScoreState,
  freshScoreState,
  type StageLite,
} from "../../opencode-plugin/score_guard";

const STAGES: StageLite[] = [
  { id: "platform" },
  { id: "model", emits: ["system"] },
  { id: "mode" },
  { id: "problem" },
  { id: "formulate", emits: ["formulation"] },
  { id: "solve", emits: ["run", "pulse"] },
  { id: "inspect" },
  { id: "device-sim", emits: ["device_session"], gate: "light" },
  { id: "hardware", emits: ["device_session"], optional: true },
];

function state(completed: string[] = [], gates: Record<string, { result: string }> = {}) {
  const s = freshScoreState("pulse-designer", 1);
  s.completed_stages = completed;
  s.gates = gates as any;
  return s;
}

describe("checkStagePrereqs — entity dependencies, not conversation order", () => {
  it("in-order entry is ok", () => {
    expect(checkStagePrereqs(STAGES, state(["platform", "model"]), "formulate")).toEqual({ ok: true });
  });
  it("blocks a stage whose emitting prerequisite is incomplete", () => {
    const r = checkStagePrereqs(STAGES, state(["platform"]), "formulate");
    expect(r).toEqual({ ok: false, code: "stage_order", required_stage: "model", missing_entities: ["system"] });
  });
  it("conversational (non-emitting) stages never block", () => {
    // mode + problem incomplete — formulate only needs model's entities
    expect(checkStagePrereqs(STAGES, state(["model"]), "formulate")).toEqual({ ok: true });
  });
  it("solve requires the formulation", () => {
    const r = checkStagePrereqs(STAGES, state(["model"]), "solve");
    expect(r).toEqual({ ok: false, code: "stage_order", required_stage: "formulate", missing_entities: ["formulation"] });
  });
  it("optional emitting stages do not block later stages", () => {
    // hardware is optional; nothing after it here, but ensure optional is excluded from blockers
    expect(checkStagePrereqs(STAGES, state(["model", "formulate", "solve"]), "inspect")).toEqual({ ok: true });
  });
  it("loopback: re-entering a completed stage is allowed", () => {
    expect(checkStagePrereqs(STAGES, state(["platform", "model", "formulate"]), "model")).toEqual({ ok: true });
  });
  it("gate stage without a passing record is blocked", () => {
    const r = checkStagePrereqs(STAGES, state(["model", "formulate", "solve"]), "device-sim");
    expect(r).toEqual({ ok: false, code: "gate_required", gate: "light" });
  });
  it("gate stage with a pass record is allowed", () => {
    const r = checkStagePrereqs(STAGES, state(["model", "formulate", "solve"], { light: { result: "pass" } }), "device-sim");
    expect(r).toEqual({ ok: true });
  });
  it("gate stage with an override record is allowed", () => {
    const r = checkStagePrereqs(STAGES, state(["model", "formulate", "solve"], { light: { result: "override" } }), "device-sim");
    expect(r).toEqual({ ok: true });
  });
  it("unknown stage id → ok (fail-open for forward compatibility)", () => {
    expect(checkStagePrereqs(STAGES, state(), "future-stage")).toEqual({ ok: true });
  });
});

describe("manifest + state IO (entitiesDir contract)", () => {
  it("loadManifest reads score_manifest.json, undefined when absent/corrupt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    expect(loadManifest(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "score_manifest.json"), JSON.stringify({ manifest: { id: "x", version: 1, stages: STAGES } }));
    expect(loadManifest(dir)?.id).toBe("x");
    fs.writeFileSync(path.join(dir, "score_manifest.json"), "{torn");
    expect(loadManifest(dir)).toBeUndefined();
  });
  it("score state round-trips and pins the version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    expect(loadScoreState(dir)).toBeUndefined();
    const s = freshScoreState("pulse-designer", 1);
    s.completed_stages.push("platform");
    saveScoreState(dir, s);
    const loaded = loadScoreState(dir)!;
    expect(loaded.score_version).toBe(1);
    expect(loaded.completed_stages).toEqual(["platform"]);
  });
});
