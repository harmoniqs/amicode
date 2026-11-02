// Lockstep test for the `dead` run state (amicode#2055, spec A2).
//
// The run-status logic exists in TWO independent copies — the extension
// service (src/amicode_service/problems.ts + run_terminal.ts) and the engine
// overlay (packages/app-bundle/overlay/.../server/amicode/problems.ts +
// run-terminal.ts). They cannot import each other, so drift is guarded here:
//   1. a shared fixture table (fixtures/run_liveness_table.json) is asserted
//      against BOTH implementations' run-status AND run-series routes;
//   2. the run.lock liveness helper is textually identical across the two
//      run-terminal files (between the BEGIN/END markers).
// Every test points at temp dirs; nothing touches ~/.amico.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runStatusBody as extStatus, runSeriesBody as extSeries } from "../src/amicode_service/problems";
import {
  runStatusBody as overlayStatus,
  runSeriesBody as overlaySeries,
} from "../../app-bundle/overlay/packages/opencode/src/server/amicode/problems";

interface Case {
  name: string;
  lock: null | { heartbeat_age_s?: number; ended?: boolean; raw?: string };
  log_age_s: number | null;
  finished?: string;
  expect: string;
}
const table: { cases: Case[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "run_liveness_table.json"), "utf8"),
);

let tmp: string;
let problems: string;
let runs: string;
const RUN_PREFIX = "r20261101-000000Z-";

/** Seed one run dir per case, plus a problem workspace referencing them all. */
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-lockstep-"));
  problems = path.join(tmp, "problems");
  runs = path.join(tmp, "runs");
  const slug = "lockstep";
  fs.mkdirSync(path.join(problems, slug), { recursive: true });
  fs.writeFileSync(path.join(problems, slug, "problem.json"), JSON.stringify({ name: "L", slug, status: "designing" }));
  const now = Date.now();
  const refs = table.cases.map((c, i) => {
    const id = `${RUN_PREFIX}${String(i).padStart(6, "0")}`;
    const dir = path.join(runs, "default", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.toml"), `run_id = "${id}"\nlab = "default"\n`);
    if (c.log_age_s !== null) {
      const log = path.join(dir, "run.log");
      fs.writeFileSync(log, "AMICODE_ITER iter=3 f=1.5e-02 inf_pr=1e-9\n");
      const t = new Date(now - c.log_age_s * 1000);
      fs.utimesSync(log, t, t);
    }
    if (c.finished !== undefined) fs.writeFileSync(path.join(dir, "FINISHED"), c.finished);
    if (c.lock) {
      const body =
        c.lock.raw ??
        JSON.stringify({
          schema: 1,
          run_id: id,
          unit: null,
          pid: 4242,
          host: "test",
          spec_hash: null,
          protection: "none",
          cloud_run_id: null,
          started_at: new Date(now - 3600_000).toISOString(),
          heartbeat_at: new Date(now - (c.lock.heartbeat_age_s ?? 0) * 1000).toISOString(),
          ended: c.lock.ended ?? false,
        });
      fs.writeFileSync(path.join(dir, "run.lock"), body);
    }
    return { run_id: id, lab: "default", recorded: "t" };
  });
  fs.writeFileSync(path.join(problems, slug, "runs.json"), JSON.stringify({ runs: refs }));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const impls = [
  { name: "extension service", status: extStatus, series: extSeries },
  { name: "engine overlay", status: overlayStatus, series: overlaySeries },
];

describe.each(impls)("run liveness fixture table — $name", (impl) => {
  it("run-status reports the expected state for every fixture", () => {
    const parsed = JSON.parse(impl.status(problems, runs, "lockstep"));
    expect(parsed.ok).toBe(true);
    const got = parsed.runs.map((r: { status: string }) => r.status);
    expect(got).toEqual(table.cases.map((c) => c.expect));
  });
  it("run-series reports the same state for every fixture", () => {
    const got = table.cases.map((_, i) => {
      const id = `${RUN_PREFIX}${String(i).padStart(6, "0")}`;
      return JSON.parse(impl.series(runs, id, "default")).run.status;
    });
    expect(got).toEqual(table.cases.map((c) => c.expect));
  });
});

describe("lockstep: the two implementations agree byte-for-byte", () => {
  it("run-status bodies are identical", () => {
    expect(overlayStatus(problems, runs, "lockstep")).toBe(extStatus(problems, runs, "lockstep"));
  });
  it("run-series bodies are identical (modulo wall-clock elapsed_ms)", () => {
    const norm = (s: string) => s.replace(/"elapsed_ms":[^,}]+/, '"elapsed_ms":"<E>"');
    table.cases.forEach((_, i) => {
      const id = `${RUN_PREFIX}${String(i).padStart(6, "0")}`;
      expect(norm(overlaySeries(runs, id, "default"))).toBe(norm(extSeries(runs, id, "default")));
    });
  });
  it("the run.lock liveness helper text is identical in both run-terminal files", () => {
    const grab = (file: string) => {
      const src = fs.readFileSync(file, "utf8");
      const m = src.match(/\/\/ BEGIN run\.lock liveness[\s\S]*?\/\/ END run\.lock liveness/);
      expect(m, `${file} must carry the BEGIN/END run.lock liveness block`).not.toBeNull();
      return m![0];
    };
    const ext = grab(path.join(__dirname, "..", "src", "amicode_service", "run_terminal.ts"));
    const overlay = grab(
      path.join(__dirname, "..", "..", "app-bundle", "overlay", "packages", "opencode", "src", "server", "amicode", "run-terminal.ts"),
    );
    expect(overlay).toBe(ext);
  });
});
