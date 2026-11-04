// #2133 — LocalExecutor emits a `local` receipt at settle with CPU measured from the run's cgroup.
// A fixture cgroup dir (a temp dir holding cpu.stat) stands in for the unit; the REAL transient-unit
// proof lives in test/slow/cost_unit.slow.test.ts. The fake julia plays the cgroup: it bumps
// usage_usec by exactly the CPU the "solve" burned, while the engine (this process) stays idle.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRoot, fakeJulia } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";
import { readRecords, type ReceiptRecord } from "../src/ledger.js";
import type { RunEvent, SubmitOpts } from "../src/types.js";

async function drain(events: AsyncIterable<RunEvent>): Promise<void> {
  for await (const _ of events);
}
const receipts = (): ReceiptRecord[] => readRecords().filter((r): r is ReceiptRecord => r.type === "receipt");

describe("LocalExecutor settle() emits a local CPU receipt", () => {
  let dir: string;
  let cg: string;
  let root: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amico-cost-le-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
    cg = join(dir, "cgroup");
    root = tmpRoot();
    writeFileSync(join(dir, "placeholder"), "");
    mkdirSync(cg);
    writeFileSync(join(cg, "cpu.stat"), "usage_usec 4000000\nuser_usec 4000000\nsystem_usec 0\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
    delete process.env.AMICO_PRINCIPAL;
    delete process.env.AMICO_LAB;
  });

  // the "solve": accrues `usec` of CPU in the fixture cgroup, then exits with `code`
  const solve = (usec: number, code = 0, extra = ""): string =>
    fakeJulia(
      root,
      `julia-${usec}-${code}`,
      `const fs=require('fs');const p=${JSON.stringify(join(cg, "cpu.stat"))};
       const cur=Number(/usage_usec (\\d+)/.exec(fs.readFileSync(p,'utf8'))[1]);
       fs.writeFileSync(p,'usage_usec '+(cur+${usec})+'\\nuser_usec 1\\nsystem_usec 1\\n');
       ${extra}
       process.exit(${code});`,
    );
  const script = (): string => fakeJulia(root, "s.jl", "");

  async function submit(julia: string, cost: SubmitOpts["cost"] = {}) {
    const h = await new LocalExecutor().submit(script(), { runsRoot: join(root, "runs"), julia: { julia }, cost: { cgroupDir: cg, ...cost } });
    await drain(h.events);
    return h.finished;
  }

  it("records the CPU the child burned in the cgroup (engine idle) — seconds only when no rate is configured", async () => {
    const fin = await submit(solve(2_500_000));
    expect(fin).toEqual({ status: "completed", exitCode: 0 });
    const [r] = receipts();
    expect(receipts()).toHaveLength(1);
    expect(r.executor).toBe("local");
    expect(r.cpu_seconds).toBeCloseTo(2.5, 6);
    expect(r.cost_usd).toBeUndefined();
    expect(r.cost_basis).toBeUndefined();
    expect(r.status).toBe("completed");
  });

  it("a rate file ⇒ cost_usd = cpu_seconds × rate, basis list_price_estimate", async () => {
    const ratesPath = join(dir, "rates.json");
    writeFileSync(ratesPath, '{"cpu_usd_per_second": 0.0002}');
    await submit(solve(2_500_000), { ratesPath });
    const [r] = receipts();
    expect(r.cpu_seconds).toBeCloseTo(2.5, 6);
    expect(r.cost_usd).toBeCloseTo(0.0005, 10);
    expect(r.cost_usd).toBe(r.cpu_seconds! * 0.0002);
    expect(r.cost_basis).toBe("list_price_estimate");
  });

  it("a malformed rates.json ⇒ seconds but no dollars, and the run still completes", async () => {
    const ratesPath = join(dir, "rates.json");
    writeFileSync(ratesPath, "{ this is not json");
    const fin = await submit(solve(1_000_000), { ratesPath });
    expect(fin.status).toBe("completed");
    const [r] = receipts();
    expect(r.cpu_seconds).toBeCloseTo(1, 6);
    expect(r.cost_usd).toBeUndefined();
  });

  it("a zero-CPU run with a rate omits cost_usd (schema exclusiveMinimum) but still records the receipt", async () => {
    const ratesPath = join(dir, "rates.json");
    writeFileSync(ratesPath, '{"cpu_usd_per_second": 0.5}');
    await submit(solve(0), { ratesPath });
    const [r] = receipts();
    expect(r.cpu_seconds).toBe(0);
    expect(r.cost_usd).toBeUndefined();
  });

  it("principal and lab come from the options, else from AMICO_PRINCIPAL / AMICO_LAB, else are absent", async () => {
    await submit(solve(100_000), { principal: "ana", lab: "labA" });
    process.env.AMICO_PRINCIPAL = "env-bo";
    process.env.AMICO_LAB = "env-labB";
    await submit(solve(100_000));
    delete process.env.AMICO_PRINCIPAL;
    delete process.env.AMICO_LAB;
    await submit(solve(100_000));
    const rs = receipts();
    expect(rs.map((r) => [r.principal, r.lab])).toEqual([
      ["ana", "labA"],
      ["env-bo", "env-labB"],
      [undefined, undefined],
    ]);
  });

  it("no unit and no cgroup (macOS / protection none) ⇒ cpu_seconds absent, cost_basis unmeasured — never an engine-clock estimate", async () => {
    const h = await new LocalExecutor().submit(script(), { runsRoot: join(root, "runs"), julia: { julia: solve(3_000_000) } });
    await drain(h.events);
    expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
    const [r] = receipts();
    expect(r.cpu_seconds).toBeUndefined();
    expect(r.cost_usd).toBeUndefined();
    expect(r.cost_basis).toBe("unmeasured");
  });

  it("a failed run keeps its exit code and records the CPU it burned, with status failed", async () => {
    const fin = await submit(solve(1_500_000, 7));
    expect(fin).toEqual({ status: "failed", exitCode: 7 });
    const [r] = receipts();
    expect(r.cpu_seconds).toBeCloseTo(1.5, 6);
    expect(r.status).toBe("failed");
  });

  it("accounting failure — the cgroup vanishes mid-run — never fails the run or changes its exit code", async () => {
    const gone = (code: number) => solve(1_000_000, code, `fs.rmSync(${JSON.stringify(cg)},{recursive:true,force:true});`);
    expect(await submit(gone(0))).toEqual({ status: "completed", exitCode: 0 });
    const [r] = receipts();
    expect(r.cpu_seconds).toBeUndefined();
    expect(r.cost_basis).toBe("unmeasured");
    expect(r.status).toBe("completed");
  });

  it("accounting failure — cpu.stat becomes unreadable garbage — same: exit code intact, unmeasured", async () => {
    const fin = await submit(
      fakeJulia(root, "julia-garbage", `require('fs').writeFileSync(${JSON.stringify(join(cg, "cpu.stat"))},'\\u0000not a cpu.stat'); process.exit(3)`),
    );
    expect(fin).toEqual({ status: "failed", exitCode: 3 });
    const [r] = receipts();
    expect(r.cpu_seconds).toBeUndefined();
    expect(r.cost_basis).toBe("unmeasured");
  });

  it("accounting failure — the ledger itself is unwritable — never fails the run", async () => {
    process.env.AMICO_LEDGER = join(dir, "placeholder", "not-a-dir", "runs.jsonl"); // parent is a file
    expect(await submit(solve(500_000))).toEqual({ status: "completed", exitCode: 0 });
  });
});
