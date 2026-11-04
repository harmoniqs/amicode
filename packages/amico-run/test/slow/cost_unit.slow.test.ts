// #2133 — REAL CPU attribution from a real transient unit's cgroup.
//
// Needs a working user service manager AND lingering; otherwise the whole file is skipped LOUDLY
// (console.warn below + the suite name says why). The fixture-cgroup logic is covered in the fast
// tier (test/cost.test.ts, test/local_executor_cost.test.ts) either way.
//
// SAFETY: only transient units named `amico-run-test-*` are created/stopped here
// (AMICO_RUN_UNIT_PREFIX=amico-run-test-); every unit this file creates is stopped in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeJulia, tmpRoot } from "../helpers.js";
import { probeUserUnits } from "../../src/placement.js";
import { resolveUnitCgroupDir, startCpuMeter } from "../../src/cost.js";
import { costTotals, type ReceiptRecord } from "../../src/ledger.js";
import { buildBundle, cliEnv, runCli, waitUntil } from "../launch_harness.js";

const PREFIX = "amico-run-test-";
const env0 = { ...process.env, AMICO_RUN_UNIT_PREFIX: PREFIX };
const probe = probeUserUnits(env0);
if (!probe.ok) console.warn(`SKIPPED cost_unit.slow tests — real systemd placement unavailable: ${probe.reason}`);

const created = new Set<string>();
const systemctl = (...args: string[]) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: env0 });

// burns >= 1.5 s of CPU in THIS child (it measures itself only to know when to stop)
const BURN = `
const t = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
let x = 0; while (t() < 1.5) { for (let i = 0; i < 1e6; i++) x += Math.sqrt(i); }
`;

beforeAll(buildBundle);
afterAll(() => {
  for (const u of created) systemctl("stop", u);
  const active = [...created].filter((u) => systemctl("is-active", u).stdout.trim() === "active");
  expect(active).toEqual([]);
});

describe.skipIf(!probe.ok)("real transient-unit CPU attribution", () => {
  it("meters the CPU a child burns inside a unit's cgroup (read from the unit's own cpu.stat)", async () => {
    const root = tmpRoot();
    const marker = join(root, "burned");
    const burner = join(root, "burner.js");
    writeFileSync(burner, `${BURN}require('fs').writeFileSync(${JSON.stringify(marker)},'x');setTimeout(()=>{},60000);`);
    const unit = `${PREFIX}meter-${randomBytes(3).toString("hex")}.service`;
    created.add(unit);
    const started = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, process.execPath, burner], { encoding: "utf8", env: env0 });
    expect(started.status, started.stderr).toBe(0);

    expect(resolveUnitCgroupDir(unit, env0)).toMatch(new RegExp(`/${unit}$`));
    const meter = startCpuMeter({ unit, env: env0 });
    await waitUntil("burned", () => existsSync(marker), 30000);
    const secs = meter.stop();
    // the meter starts a few ms into the burn at worst: >= 1.0 s of the 1.5 s the child burned
    expect(secs).toBeGreaterThanOrEqual(1.0);
    expect(secs).toBeLessThan(30);
    systemctl("stop", unit);
  }, 60000);

  it("an `amico run` in a real unit whose idle engine only waits: the receipt carries the CHILD's >= 1 s, priced by the rate file, attributed to principal and Lab", async () => {
    const root = tmpRoot();
    const ledger = join(root, "runs.jsonl");
    const rates = join(root, "rates.json");
    writeFileSync(rates, '{"cpu_usd_per_second": 0.001}');
    const julia = fakeJulia(root, "j", BURN);
    const env = cliEnv({
      AMICO_RUN_PLACEMENT: "auto",
      AMICO_RUN_UNIT_PREFIX: PREFIX,
      AMICO_LEDGER: ledger,
      AMICO_RATES_FILE: rates,
      AMICO_PRINCIPAL: "ana",
      AMICO_LAB: "labA",
    });
    const r = await runCli(["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", julia], env);
    expect(r.code, r.stderr).toBe(0);
    for (const d of readdirSync(join(root, "runs"))) {
      try {
        const lock = JSON.parse(readFileSync(join(root, "runs", d, "run.lock"), "utf8"));
        if (lock.unit) {
          created.add(lock.unit);
          expect(lock.protection).toBe("unit");
        }
      } catch {
        /* not a run dir */
      }
    }
    const recs = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ReceiptRecord);
    const rec = recs.filter((x) => x.type === "receipt");
    expect(rec).toHaveLength(1);
    expect(rec[0].executor).toBe("local");
    expect(rec[0].cpu_seconds).toBeGreaterThanOrEqual(1.0);
    expect(rec[0].cpu_seconds).toBeLessThan(30);
    expect(rec[0].cost_basis).toBe("list_price_estimate");
    expect(rec[0].cost_usd).toBeCloseTo(rec[0].cpu_seconds! * 0.001, 12);
    expect([rec[0].principal, rec[0].lab]).toEqual(["ana", "labA"]);
    expect(costTotals(rec).by_principal.ana.cpu_seconds).toBeGreaterThanOrEqual(1.0);
  }, 90000);
});
