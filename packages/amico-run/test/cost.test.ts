// #2133 — cost attribution units: cgroup cpu.stat parsing + delta, the rate file, the cost fields,
// the rollups, and the guard that the engine-process clock is never the source of a solve's CPU.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costFields, parseUsageUsec, readCpuRate, startCpuMeter } from "../src/cost.js";
import { costTotals, gpuTotals, type LedgerRecord, type ReceiptRecord } from "../src/ledger.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "amico-cost-"));
const cpuStat = (usec: number): string =>
  `usage_usec ${usec}\nuser_usec ${usec - 10}\nsystem_usec 10\nnice_usec 0\ncore_sched.force_idle_usec 0\nnr_periods 0\n`;

describe("cgroup cpu.stat reading", () => {
  it("parses usage_usec from a real-shaped cpu.stat (and not user_usec/system_usec)", () => {
    expect(parseUsageUsec(cpuStat(1844))).toBe(1844);
  });
  it("returns undefined for text without usage_usec", () => {
    expect(parseUsageUsec("")).toBeUndefined();
    expect(parseUsageUsec("user_usec 5\nsystem_usec 5\n")).toBeUndefined();
    expect(parseUsageUsec("usage_usec banana\n")).toBeUndefined();
  });
  it("the meter reports the delta between the start reading and the stop reading, in seconds", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cpu.stat"), cpuStat(2_000_000));
    const m = startCpuMeter({ cgroupDir: dir });
    writeFileSync(join(dir, "cpu.stat"), cpuStat(3_750_000));
    expect(m.stop()).toBeCloseTo(1.75, 6);
  });
  it("a cgroup that already had CPU history only counts what accrued after the start reading", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cpu.stat"), cpuStat(9_000_000_000));
    const m = startCpuMeter({ cgroupDir: dir });
    expect(m.stop()).toBe(0);
  });
  it("no unit and no cgroup dir ⇒ not measured (undefined), without a warning", () => {
    expect(startCpuMeter({}).stop()).toBeUndefined();
    expect(startCpuMeter({ unit: null }).stop()).toBeUndefined();
  });
  it("a vanished or unreadable cpu.stat ⇒ undefined, never a throw", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cpu.stat"), cpuStat(1_000_000));
    const m = startCpuMeter({ cgroupDir: dir });
    rmSync(dir, { recursive: true });
    expect(m.stop()).toBeUndefined();
    expect(startCpuMeter({ cgroupDir: join(dir, "never-existed") }).stop()).toBeUndefined();
  });
  it("a cpu.stat that goes backwards (cgroup recreated) is not reported as negative CPU", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cpu.stat"), cpuStat(5_000_000));
    const m = startCpuMeter({ cgroupDir: dir });
    writeFileSync(join(dir, "cpu.stat"), cpuStat(100));
    expect(m.stop()).toBeUndefined();
  });
});

describe("the rate file", () => {
  const rates = (body: string): string => {
    const f = join(tmp(), "rates.json");
    writeFileSync(f, body);
    return f;
  };
  it("reads cpu_usd_per_second", () => {
    expect(readCpuRate(rates('{"cpu_usd_per_second": 0.00005}'))).toBe(0.00005);
  });
  it("absent file ⇒ no rate", () => {
    expect(readCpuRate(join(tmp(), "nope.json"))).toBeUndefined();
  });
  it("malformed or wrongly-typed content ⇒ no rate, never a throw", () => {
    for (const body of ["{not json", "", "null", "[]", '{"cpu_usd_per_second": "0.1"}', '{"cpu_usd_per_second": -1}', '{"cpu_usd_per_second": 0}', '{"other": 1}'])
      expect(readCpuRate(rates(body)), body).toBeUndefined();
  });
});

describe("costFields", () => {
  it("no measurement ⇒ cost_basis unmeasured, no seconds, no dollars — even with a rate", () => {
    expect(costFields(undefined, 0.01)).toEqual({ cost_basis: "unmeasured" });
  });
  it("seconds but no rate ⇒ seconds only (no invented dollars, no basis)", () => {
    expect(costFields(2.5, undefined)).toEqual({ cpu_seconds: 2.5 });
  });
  it("seconds and a rate ⇒ cost_usd = seconds × rate, basis list_price_estimate, unrounded", () => {
    const f = costFields(1.234567, 0.00003);
    expect(f.cpu_seconds).toBe(1.234567);
    expect(f.cost_usd).toBe(1.234567 * 0.00003);
    expect(f.cost_basis).toBe("list_price_estimate");
  });
  it("a zero cost is omitted (schema exclusiveMinimum), the measured seconds are kept", () => {
    expect(costFields(0, 0.01)).toEqual({ cpu_seconds: 0 });
  });
});

describe("costTotals", () => {
  const rec = (over: Partial<ReceiptRecord>): ReceiptRecord => ({
    type: "receipt",
    ts: "2026-11-04T00:00:00Z",
    task_id: "t",
    executor: "local",
    ...over,
  });
  const rows: LedgerRecord[] = [
    rec({ principal: "ana", lab: "labA", cpu_seconds: 10.00004, cost_usd: 0.50002 }),
    rec({ principal: "ana", lab: "labB", cpu_seconds: 5, cost_usd: 0.25 }),
    rec({ principal: "bo", lab: "labA", cpu_seconds: 1, cost_usd: 0.05 }),
    rec({ cpu_seconds: 2 }), // unattributed, no rate
    rec({ cost_basis: "unmeasured" }), // unattributed, nothing measured
    rec({ executor: "remote", gpu_seconds: 100, cost_usd: 9 }), // GPU row: not part of the CPU rollup
  ];
  it("principal and Lab breakdowns each sum to the total", () => {
    const t = costTotals(rows);
    expect(t.receipts).toBe(5);
    for (const by of [t.by_principal, t.by_lab]) {
      const vals = Object.values(by);
      expect(vals.reduce((a, b) => a + b.receipts, 0)).toBe(t.receipts);
      expect(vals.reduce((a, b) => a + b.cpu_seconds, 0)).toBeCloseTo(t.cpu_seconds, 4);
      expect(vals.reduce((a, b) => a + b.cost_usd, 0)).toBeCloseTo(t.cost_usd, 4);
      expect(vals.reduce((a, b) => a + b.unmeasured, 0)).toBe(t.unmeasured);
    }
    expect(t.cpu_seconds).toBeCloseTo(18.0, 3);
    expect(t.cost_usd).toBeCloseTo(0.80002, 4);
  });
  it("rows without a principal or Lab roll up under (unattributed)", () => {
    const t = costTotals(rows);
    expect(t.by_principal["(unattributed)"]).toMatchObject({ receipts: 2, cpu_seconds: 2, unmeasured: 1 });
    expect(t.by_lab["(unattributed)"]).toMatchObject({ receipts: 2, cpu_seconds: 2, unmeasured: 1 });
    expect(t.by_principal.ana.receipts).toBe(2);
    expect(t.by_lab.labA.receipts).toBe(2);
  });
  it("rounds to 1e-4 in the rollup only; the records themselves are untouched", () => {
    const t = costTotals(rows);
    expect(t.by_principal.ana.cost_usd).toBe(0.7500);
    expect(t.by_principal.ana.cpu_seconds).toBe(15.0000);
    expect((rows[0] as ReceiptRecord).cost_usd).toBe(0.50002);
  });
  it("empty input ⇒ zeros and empty breakdowns", () => {
    expect(costTotals([])).toEqual({ receipts: 0, cpu_seconds: 0, cost_usd: 0, unmeasured: 0, by_principal: {}, by_lab: {} });
  });
  it("local CPU receipts do not leak into the GPU totals the warrant fold reads", () => {
    const f = join(tmp(), "runs.jsonl");
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const g = gpuTotals(f);
    expect(g.receipts).toBe(1);
    expect(g.gpu_seconds).toBe(100);
    expect(g.cost_usd).toBe(9);
  });
});

describe("the engine process clock is never a source of solve CPU", () => {
  it("neither local_executor.ts nor cost.ts calls the engine-process CPU clock", () => {
    for (const f of ["local_executor.ts", "cost.ts"]) {
      const code = readFileSync(join(__dirname, "..", "src", f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/cpuUsage|resourceUsage|getrusage/);
    }
  });
  it("the literal `process.cpuUsage` does not appear anywhere in local_executor.ts", () => {
    expect(readFileSync(join(__dirname, "..", "src", "local_executor.ts"), "utf8")).not.toContain("process.cpuUsage");
  });
});
