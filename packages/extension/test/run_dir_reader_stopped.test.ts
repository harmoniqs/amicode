import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStopped, ingestRunDir } from "../src/run_dir_reader";

describe("detectStopped", () => {
  it("true when run.log carries the AMICODE_STOPPED marker", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.log"), "AMICODE_ITER iter=3 f=1e-2 inf_pr=1e-3 inf_du=1e-3\nAMICODE_STOPPED\n");
    expect(detectStopped(d)).toBe(true);
  });
  it("false when no marker (converged run)", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.log"), "AMICODE_ITER iter=60 f=1e-6 inf_pr=1e-8 inf_du=1e-8\nDONE fidelity=0.999\n");
    expect(detectStopped(d)).toBe(false);
  });
  it("false when run.log absent", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    expect(detectStopped(d)).toBe(false);
  });
});

describe("ingestRunDir — stopped relabel", () => {
  // run.schema.json is additionalProperties:false and requires schema_version,
  // run_id, script_path, lab, lab_id, created_at, orchestrator_version, and a
  // [julia] table with binary — mirror an actual run.toml exactly.
  const manifest =
    `schema_version="2"\nrun_id="r-test"\ntier="vetted"\nlab="default"\nlab_id="default"\n` +
    `script_path="/x/solve.jl"\ncreated_at="2026-07-04T00:00:00Z"\norchestrator_version="0.1.0"\n` +
    `[julia]\nbinary="julia"\nproject="/x"\n`;

  function sinkSpy() {
    const runs: Array<{ status: string; fidelity?: number }> = [];
    const promotes: unknown[] = [];
    return {
      runs, promotes,
      sink: { iter() {}, pulse() {}, run: (r: never) => runs.push(r as never), promote: (p: never) => promotes.push(p) },
    };
  }

  it("relabels a completed+STOPPED run to 'stopped' and skips promote", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.toml"), manifest);
    writeFileSync(join(d, "FINISHED"), `status="completed"\nexit_code=0\n`);
    writeFileSync(join(d, "result.toml"), `schema_version="1"\nfidelity=0.9999\niterations=3\nwall_seconds=2.0\n`);
    writeFileSync(join(d, "run.log"), "AMICODE_STOPPED\n");
    const { runs, promotes, sink } = sinkSpy();
    ingestRunDir(d, sink as never);
    expect(runs.at(-1)?.status).toBe("stopped");
    expect(promotes).toHaveLength(0);
  });

  it("leaves a genuinely converged run as 'completed' and promotes", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.toml"), manifest);
    writeFileSync(join(d, "FINISHED"), `status="completed"\nexit_code=0\n`);
    writeFileSync(join(d, "result.toml"), `schema_version="1"\nfidelity=0.9999\niterations=60\nwall_seconds=5.0\n`);
    writeFileSync(join(d, "run.log"), "DONE fidelity=0.9999\n");
    const { runs, promotes, sink } = sinkSpy();
    ingestRunDir(d, sink as never);
    expect(runs.at(-1)?.status).toBe("completed");
    expect(promotes).toHaveLength(1);
  });
});
