// Integration: real runs of the whole harness against a real host. Skipped unless H0A_SMOKE=1 (each run takes minutes,
// so it is not part of the < 60 s unit suite):
//
//   cd docs/spikes/h0a-harness && env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT H0A_SMOKE=1 bun test smoke.test.ts
//
// 1. SMOKE: --sessions 4 --duration-s 90 --warmup-s 15, with a short reconnect interval so the reconnect path runs.
// 2. NEGATIVE CONTROL: the same harness with the host SIGSTOPped (by exact pid) for 3 s: exactly one wedge must be reported,
//    which proves the wedge path can fail and that the smoke's zero is a measurement, not a blind spot.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { readNdjson } from "./common.ts"

const enabled = process.env.H0A_SMOKE === "1"
const run = enabled ? describe : describe.skip
const here = import.meta.dir
const ROOT = "/tmp/opencode/h0a"

/** Processes (other than this test and its ancestors) whose cwd or command line is under `dir`. */
function processesUnder(dir: string) {
  const ancestors = new Set<number>([process.pid])
  for (let pid = process.ppid; pid > 1 && !ancestors.has(pid); ) {
    ancestors.add(pid)
    try {
      pid = Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1])
    } catch {
      break
    }
  }
  return fs
    .readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p) && !ancestors.has(Number(p)))
    .flatMap((p) => {
      try {
        const cwd = fs.readlinkSync(`/proc/${p}/cwd`)
        const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replaceAll("\0", " ")
        return cwd.startsWith(dir) || cmd.includes(dir + "/") || cmd.includes(dir + " ") ? [`${p} ${cmd.slice(0, 120)}`] : []
      } catch {
        return []
      }
    })
}

const spawned: { out: string; proc: Bun.Subprocess }[] = []
afterAll(() => {
  // If a test died before the harness finished, stop it by the exact runner pid it recorded (never by pattern).
  for (const { out, proc } of spawned) {
    if (proc.exitCode !== null) continue
    try {
      const runner = JSON.parse(fs.readFileSync(path.join(out, "pids.json"), "utf8")).runner as number
      process.kill(runner, "SIGTERM")
    } catch {}
  }
})

async function level(name: string, flags: string[], timeoutMs: number) {
  const out = path.join(ROOT, name)
  fs.rmSync(out, { recursive: true, force: true })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" } // no BUN_INSPECT, nothing else
  const proc = Bun.spawn(["bash", path.join(here, "run.sh"), "--out", out, ...flags], { env, stdout: Bun.file(`${out}.stdout`), stderr: Bun.file(`${out}.stderr`) })
  spawned.push({ out, proc })
  const code = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)])
  if (code === "timeout") throw new Error(`harness did not finish within ${timeoutMs} ms; see ${out}.stderr`)
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"))
  return { out, code, summary }
}

run("harness smoke: 4 sessions, 90 s after a 15 s warm-up", () => {
  test("runs end to end, probes and records everything, reports zero wedges, and leaves nothing behind", async () => {
    const { out, code, summary } = await level("smoke", ["--sessions", "4", "--duration-s", "90", "--warmup-s", "15", "--seed", "7", "--reconnect-min-s", "20", "--reconnect-max-s", "40"], 330_000)

    // the summary was produced and is a verdict, from complete inputs
    expect(["pass", "fail", "inconclusive", "invalid"]).toContain(summary.verdict)
    expect(summary.problems).toEqual([])
    expect(summary.criteria.map((c: { criterion: string }) => c.criterion)).toEqual(["latency", "no_wedge", "memory", "turns"])
    expect(code).not.toBe(3) // 3 = the harness itself broke (invalid inputs)

    // at least one turn per session completed
    const turns = readNdjson<{ session: string; outcome: string }>(path.join(out, "turns.ndjson"))
    const completed = new Set(turns.filter((t) => t.outcome === "succeeded").map((t) => t.session))
    expect(completed.size).toBe(4)

    // the probe recorded host and control samples (>= 300 each over the 105 s run at 4 Hz)
    const probe = readNdjson<{ h: number | null; c: number | null; hs: number; cs: number }>(path.join(out, "probe.ndjson"))
    expect(probe.filter((r) => r.hs === 200).length).toBeGreaterThanOrEqual(300)
    expect(probe.filter((r) => r.cs === 200).length).toBeGreaterThanOrEqual(300)

    // zero wedges, in the window and in warm-up
    const wedge = summary.criteria.find((c: { criterion: string }) => c.criterion === "no_wedge")
    expect(wedge).toMatchObject({ wedges: 0, warmup_wedges: 0, unplanned_host_exits: 0 })

    // the paced model was actually driven: every 5th request a tool call, streams were concurrent
    const model = JSON.parse(fs.readFileSync(path.join(out, "model-stats.json"), "utf8"))
    expect(model.requests).toBeGreaterThan(20)
    expect(model.tool).toBeGreaterThan(0)
    expect(model.maxActive).toBeGreaterThan(1)

    // the permission path ran: shell calls were refused, and turns containing them still ended
    expect(summary.driver_stats.failed + summary.driver_stats.lost).toBe(0)

    // the reconnect path ran (a chaos subscriber aborted and came back)
    const subscribers = Object.values(summary.driver_stats.subscribers) as { planned_aborts: number; connects: number }[]
    expect(subscribers.some((s) => s.planned_aborts > 0 && s.connects > 1)).toBe(true)

    // nothing left behind: the harness's own report, and an independent /proc scan of the run directory
    expect(summary.leftovers).toEqual([])
    expect(processesUnder(out)).toEqual([])
    expect(fs.existsSync(path.join(out, "sbx"))).toBe(false) // sandbox removed (database size is in final.json)
  }, 360_000)
})

run("negative control: SIGSTOP the host for 3 s", () => {
  test("exactly one wedge is reported, the run fails, and the host is resumed and stopped cleanly", async () => {
    const { out, code, summary } = await level("negctl", ["--sessions", "2", "--duration-s", "30", "--warmup-s", "5", "--seed", "9", "--sigstop-at-s", "10", "--sigstop-for-s", "3"], 200_000)
    const wedge = summary.criteria.find((c: { criterion: string }) => c.criterion === "no_wedge")
    expect(wedge).toMatchObject({ wedges: 1, status: "fail", unplanned_host_exits: 0 })
    expect(wedge.wedge_events).toHaveLength(1)
    expect(summary.verdict).toBe("fail")
    expect(code).toBe(1)

    const events = readNdjson<{ event: string; pid?: number }>(path.join(out, "events.ndjson"))
    const pids = JSON.parse(fs.readFileSync(path.join(out, "pids.json"), "utf8"))
    const stop = events.find((e) => e.event === "fault_sigstop")
    expect(stop?.pid).toBe(pids.host) // only the host this run started, by its recorded pid
    expect(events.some((e) => e.event === "fault_sigcont" && e.pid === pids.host)).toBe(true)
    // the outage is about as long as the stop (probe ticks that went unanswered for the first ~1 s of it)
    expect(wedge.wedge_events[0].end - wedge.wedge_events[0].start).toBeGreaterThan(500)
    expect(wedge.wedge_events[0].end - wedge.wedge_events[0].start).toBeLessThan(4000)
    expect(summary.leftovers).toEqual([])
    expect(processesUnder(out)).toEqual([])
  }, 240_000)
})
