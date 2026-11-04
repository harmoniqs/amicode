// CPU cost attribution for a local solve (central-hub cost ledger, ADR 0041 §5; #2133).
//
// WHAT IS MEASURED. A solve's real CPU is burned by the Julia child (and its threads), NOT by
// the engine/orchestrator process: `process.cpuUsage()` sees only the latter and would cost every
// solve at ~zero, so it is deliberately never used here (a test greps for it). Since #2045 each
// solve runs in its own transient unit `amico-run-<id>.service`; that unit's cgroup accounts the
// CPU of every process in it, children and threads included.
//
// HOW. `cpu.stat` `usage_usec` of the unit's cgroup (cgroup v2), read once as early as practical
// (startRun, before Julia is spawned) and once at settle (before the unit is torn down); the
// delta is `cpu_seconds`. We read the file rather than `systemctl show -p CPUUsageNSec` because
// (a) it needs no CPUAccounting property on the unit — v2 always maintains usage_usec — and
// (b) after the first lookup it is one file read, with no subprocess at settle. The cgroup
// directory is resolved ONCE, via `systemctl --user show -p ControlGroup --value <unit>`.
//
// No unit / no cgroup (macOS, protection:"none"): nothing is measured and the record says
// `cost_basis: "unmeasured"` — no estimate, no fallback to engine-process CPU.
//
// Accounting never fails a run: every function here is total (returns undefined on any fault).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { managerEnv } from "./placement.js";
import type { ReceiptRecord } from "./ledger.js";

const CGROUP_ROOT = "/sys/fs/cgroup";

/** `usage_usec` from the text of a cgroup v2 `cpu.stat`, or undefined. */
export function parseUsageUsec(cpuStat: string): number | undefined {
  const m = /^usage_usec\s+(\d+)\s*$/m.exec(cpuStat);
  return m ? Number(m[1]) : undefined;
}

/** Absolute cgroup directory of a systemd user unit, or undefined (not Linux, unit gone, no bus). */
export function resolveUnitCgroupDir(unit: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== "linux") return undefined;
  const r = spawnSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit], {
    env: managerEnv(env),
    encoding: "utf8",
    timeout: 10000,
  });
  const cg = r.status === 0 ? r.stdout.trim() : "";
  return cg.startsWith("/") ? join(CGROUP_ROOT, cg) : undefined;
}

export interface CpuMeter {
  /** CPU-seconds consumed in the cgroup since the meter started; undefined if it cannot be read. */
  stop(): number | undefined;
}

const NO_METER: CpuMeter = { stop: () => undefined };

/** Start metering. `cgroupDir` (a directory holding `cpu.stat`) wins over `unit`; it is the test
 *  seam and also lets a caller that already knows the cgroup skip the systemctl lookup. With
 *  neither, the run simply is not measured (silently: that is the macOS / unplaced case). A
 *  measurement that was expected and failed is reported on stderr, once per meter. */
export function startCpuMeter(src: { unit?: string | null; cgroupDir?: string; env?: NodeJS.ProcessEnv }): CpuMeter {
  if (!src.cgroupDir && !src.unit) return NO_METER;
  let warned = false;
  const warn = (why: string): undefined => {
    if (!warned) process.stderr.write(`amico-run: cpu accounting unavailable (${why}); run unaffected\n`);
    warned = true;
    return undefined;
  };
  try {
    const dir = src.cgroupDir ?? resolveUnitCgroupDir(src.unit!, src.env);
    if (!dir) return { stop: () => warn("no cgroup for the run's unit") };
    const read = (): number | undefined => parseUsageUsec(readFileSync(join(dir, "cpu.stat"), "utf8"));
    const start = read();
    if (start === undefined) return { stop: () => warn("no usage_usec in cpu.stat") };
    return {
      stop() {
        try {
          const end = read();
          return end === undefined || end < start ? warn("cpu.stat went backwards or lost usage_usec") : (end - start) / 1e6;
        } catch (e) {
          return warn((e as Error).message);
        }
      },
    };
  } catch (e) {
    return { stop: () => warn((e as Error).message) };
  }
}

/** `~/.amico/amicode/rates.json` (human-edited), or `$AMICO_RATES_FILE`. */
export function ratesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AMICO_RATES_FILE || join(homedir(), ".amico", "amicode", "rates.json");
}

/** `cpu_usd_per_second` from the rates file; undefined when absent, malformed, or not a positive
 *  finite number — an unconfigured install records seconds and no invented dollars. */
export function readCpuRate(path: string = ratesPath()): number | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { cpu_usd_per_second?: unknown } | null)?.cpu_usd_per_second;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The cost fields of a local receipt. Per-record values are NOT rounded (rollups round). */
export function costFields(
  cpuSeconds: number | undefined,
  rate: number | undefined,
): Pick<ReceiptRecord, "cpu_seconds" | "cost_usd" | "cost_basis"> {
  if (cpuSeconds === undefined) return { cost_basis: "unmeasured" };
  const cost = rate === undefined ? 0 : cpuSeconds * rate;
  // schema: cost_usd exclusiveMinimum 0 — omit a zero (or non-finite) cost rather than violate it
  return cost > 0 && Number.isFinite(cost)
    ? { cpu_seconds: cpuSeconds, cost_usd: cost, cost_basis: "list_price_estimate" }
    : { cpu_seconds: cpuSeconds };
}
