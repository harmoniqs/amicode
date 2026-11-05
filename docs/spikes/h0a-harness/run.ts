// Orchestrates ONE load level: sandbox, paced model, control, host, sampler, probe, driver; then teardown by recorded pid
// and process group, a leftover check, and summary.json.
//
// Safety, in the order it matters:
//  - Run it through run.sh: that makes this process the leader of its OWN process group (setsid). It refuses to start
//    otherwise, because teardown signals the group and must never reach a shell, a test runner or anyone else's process.
//  - Every child pid is recorded in <out>/pids.json the moment it starts. Teardown stops children by those exact pids,
//    then sweeps what is left of the run's own process group/session (/proc scan, signalled by exact pid only), then reports
//    anything of the run's that is still alive. It never signals by command-line text or cwd.
//  - Loopback only; ports 53000-53999 only; temp XDG/HOME and a fresh database file under <out>/sbx; random password in a
//    0600 file; OPENCODE_DISABLE_FREE_MODELS=1; no credentials. Never reads or writes ~/.amico, ~/.config/systemd or
//    ~/.local/share/opencode, and never touches any systemd unit.
import fs from "node:fs"
import path from "node:path"
import { args, basic, freePort, ndjson } from "./common.ts"
import { hostEnv, makeSandbox } from "./sandbox.ts"
import { summarizeRun } from "./summarize.ts"

const HERE = import.meta.dir
const HOST_MAIN = path.resolve(HERE, "../../../packages/host/bin/amicode-host.mjs")

const a = args(process.argv.slice(2))
const out = path.resolve(a.out ?? "")
if (!a.out || !out.startsWith("/tmp/")) {
  console.error("--out <dir> is required and must be under /tmp (the run directory holds the sandbox and the database)")
  process.exit(64)
}
const num = (key: string, fallback: number) => (a[key] === undefined ? fallback : Number(a[key]))
const cfg = {
  sessions: num("sessions", 12),
  durationS: num("duration-s", 7200),
  warmupS: num("warmup-s", 300),
  seed: num("seed", 1),
  modelMinS: num("model-min-s", 2),
  modelMaxS: num("model-max-s", 8),
  reconnectMinS: num("reconnect-min-s", 120),
  reconnectMaxS: num("reconnect-max-s", 300),
  pollEveryS: num("poll-every-s", 5),
  sigstopAtS: a["sigstop-at-s"] === undefined ? undefined : Number(a["sigstop-at-s"]), // fault injection: negative control for the wedge detector
  sigstopForS: num("sigstop-for-s", 3),
  keepSandbox: a["keep-sandbox"] === "true",
}
if (!(cfg.sessions >= 1) || !(cfg.durationS > 0) || !(cfg.warmupS >= 0)) {
  console.error("--sessions >= 1, --duration-s > 0, --warmup-s >= 0 required")
  process.exit(64)
}

// ---- must be the leader of our own process group (see the header)
const pgrp = Number(fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ")[2])
if (pgrp !== process.pid) {
  console.error(`refusing to run: not a process-group leader (pid ${process.pid}, pgrp ${pgrp}). Start it with run.sh, which uses setsid.`)
  process.exit(64)
}

fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (f !== "sbx") fs.rmSync(path.join(out, f), { recursive: true, force: true })
fs.rmSync(path.join(out, "sbx"), { recursive: true, force: true })
const sb = makeSandbox(out)
const events = ndjson(path.join(out, "events.ndjson"))
const note = (event: string, extra: Record<string, unknown> = {}) => events.write({ t: Date.now(), event, ...extra })
const pidFile = path.join(out, "pids.json")
const pids: Record<string, number> = {}
const recordPid = (name: string, pid: number) => {
  pids[name] = pid
  fs.writeFileSync(pidFile, JSON.stringify({ runner: process.pid, pgrp, ...pids }, null, 2))
}
recordPid("runner", process.pid)

// ---- children
const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sb.home, XDG_STATE_HOME: sb.state, XDG_DATA_HOME: sb.data, XDG_CONFIG_HOME: sb.config, XDG_CACHE_HOME: sb.cache }
let tearingDown = false
const children = new Map<string, Bun.Subprocess<"ignore", "pipe", "pipe">>()

/** Pump a stream to a log file and resolve the first line, so "listening" announcements can be awaited. */
function pump(stream: ReadableStream<Uint8Array>, file: string) {
  const fd = fs.openSync(file, "a", 0o600)
  let first!: (line: string) => void
  const firstLine = new Promise<string>((resolve) => (first = resolve))
  void (async () => {
    const decoder = new TextDecoder()
    let seen = false
    let buffer = ""
    for await (const chunk of stream) {
      fs.writeSync(fd, chunk)
      if (!seen) {
        buffer += decoder.decode(chunk, { stream: true })
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          seen = true
          first(buffer.slice(0, newline))
        }
      }
    }
    fs.closeSync(fd)
  })()
  return firstLine
}

function start(name: string, argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(argv, { cwd: options.cwd ?? out, env: options.env ?? childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  children.set(name, proc)
  recordPid(name, proc.pid)
  const firstLine = pump(proc.stdout, path.join(out, `${name}.log`))
  void pump(proc.stderr, path.join(out, `${name}.err.log`))
  note(`${name}_started`, { pid: proc.pid, planned: true })
  void proc.exited.then((code) => {
    // The driver finishing on its own (exit 0) is the run's normal end; anything else before teardown is unplanned.
    note(`${name}_exit`, { pid: proc.pid, code, planned: tearingDown || (name === "driver" && code === 0) })
  })
  return { proc, firstLine }
}
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out waiting for ${what}`)))])

// ---- teardown: exact pids first, then the group sweep, then a leftover report
async function teardown() {
  if (tearingDown) return
  tearingDown = true
  note("teardown_started", { planned: true })
  const host = children.get("host")
  if (host && host.exitCode === null) {
    try {
      process.kill(host.pid, "SIGCONT") // a SIGSTOPped host cannot handle SIGTERM
    } catch {}
  }
  // Order: driver (stop load), probe/sampler (flush), host (flushes its db), model, control.
  for (const name of ["driver", "probe", "sampler", "host", "model", "control"]) {
    const proc = children.get(name)
    if (!proc || proc.exitCode !== null) continue
    if (name === "model") {
      const stats = await fetch(`http://127.0.0.1:${ports.model}/__stats`).then((r) => r.json()).catch(() => undefined)
      if (stats) fs.writeFileSync(path.join(out, "model-stats.json"), JSON.stringify(stats, null, 2) + "\n")
    }
    proc.kill("SIGTERM")
    await Promise.race([proc.exited, Bun.sleep(name === "host" ? 25_000 : 8000)])
    if (proc.exitCode === null) {
      note("sigkill", { name, pid: proc.pid })
      proc.kill("SIGKILL")
      await proc.exited
    }
  }
  // What is still alive that belongs to THIS run: same process group or same session as the runner (setsid made us the
  // leader of both), by exact pid. Matching on command-line text or cwd is deliberately NOT used to choose what to
  // signal: the shell that launched us has this run directory in its own command line, and so may someone's `cd` shell.
  const ancestors = (() => {
    const set = new Set<number>()
    for (let pid = process.ppid; pid > 1 && !set.has(pid); ) {
      set.add(pid)
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      } catch {
        break
      }
    }
    return set
  })()
  const survivors = () =>
    fs
      .readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid && !ancestors.has(Number(p)))
      .flatMap((p) => {
        try {
          const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8")
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
          if (fields[0] === "Z") return [] // a zombie holds no resources and only needs its parent to reap it
          if (Number(fields[2]) !== pgrp && Number(fields[3]) !== pgrp) return []
          return [{ pid: Number(p), cmd: fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 160) }]
        } catch {
          return []
        }
      })
  // Group sweep, by exact pid (never a pattern): anything the children left behind.
  for (const survivor of survivors()) {
    note("sweep", { ...survivor })
    try {
      process.kill(survivor.pid, "SIGTERM")
    } catch {}
  }
  await Bun.sleep(1500)
  for (const survivor of survivors()) {
    try {
      process.kill(survivor.pid, "SIGKILL")
    } catch {}
  }
  await Bun.sleep(300)
  const left = survivors()
  note("leftover_check", { leftovers: left, planned: true })
  return left
}

// ---- the run
const ports = { model: await freePort(), control: 0, host: 0 }
ports.control = await freePort([ports.model])
ports.host = await freePort([ports.model, ports.control])
let signalled: string | undefined
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (signalled ??= sig))

let leftovers: { pid: number; cmd: string }[] = []
let exitCode = 0
try {
  const model = start("model", [process.execPath, path.join(HERE, "model.ts"), "--port", String(ports.model), "--seed", String(cfg.seed), "--min-s", String(cfg.modelMinS), "--max-s", String(cfg.modelMaxS)])
  await within(model.firstLine, 20_000, "the model server")
  const control = start("control", [process.execPath, path.join(HERE, "control.ts"), "--port", String(ports.control)])
  await within(control.firstLine, 20_000, "the control server")

  const providerConfig = {
    providers: { fake: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${ports.model}/v1`, apiKey: "not-a-real-key" }, models: { m: {} } } },
  }
  const host = start("host", [process.execPath, HOST_MAIN], { cwd: sb.work, env: hostEnv(sb, { port: ports.host, providerConfig }) })
  const hostUrl = `http://127.0.0.1:${ports.host}`
  const auth = { authorization: basic(sb.password) }
  const hostReady = (async () => {
    for (;;) {
      if (host.proc.exitCode !== null) throw new Error(`host exited during start (${host.proc.exitCode}); see ${out}/host.err.log`)
      const ok = await fetch(`${hostUrl}/amicode/ping`, { headers: auth, signal: AbortSignal.timeout(2000) }).then((r) => r.status === 200).catch(() => false)
      if (ok) return
      await Bun.sleep(250)
    }
  })()
  await within(hostReady, 90_000, "the host to answer /amicode/ping")
  note("host_ready", { pid: host.proc.pid, port: ports.host, planned: true })

  const sampler = start("sampler", [process.execPath, path.join(HERE, "sampler.ts"), "--host-pid", String(host.proc.pid), "--also", `model=${model.proc.pid},control=${control.proc.pid}`, "--out", path.join(out, "sampler.ndjson")])
  await within(sampler.firstLine, 20_000, "the sampler")
  const probe = start("probe", [process.execPath, path.join(HERE, "probe.ts"), "--host-url", hostUrl, "--control-url", `http://127.0.0.1:${ports.control}`, "--password-file", sb.passwordFile, "--out", path.join(out, "probe.ndjson")])
  await within(probe.firstLine, 20_000, "the probe")

  const driver = start("driver", [
    process.execPath, path.join(HERE, "driver.ts"),
    "--url", hostUrl, "--password-file", sb.passwordFile, "--work", sb.work, "--out", out,
    "--sessions", String(cfg.sessions), "--duration-s", String(cfg.durationS), "--warmup-s", String(cfg.warmupS), "--seed", String(cfg.seed),
    "--reconnect-min-s", String(cfg.reconnectMinS), "--reconnect-max-s", String(cfg.reconnectMaxS), "--poll-every-s", String(cfg.pollEveryS),
  ])
  const window = JSON.parse(await within(driver.firstLine, 180_000, "the driver to create its sessions and announce the window")) as { t0: number; measure_from: number; measure_until: number }
  fs.writeFileSync(
    path.join(out, "run.json"),
    JSON.stringify({ ...window, duration_s: cfg.durationS, warmup_s: cfg.warmupS, sessions: cfg.sessions, seed: cfg.seed, ports, host_pid: host.proc.pid, bun: Bun.version, model_s: [cfg.modelMinS, cfg.modelMaxS], reconnect_s: [cfg.reconnectMinS, cfg.reconnectMaxS], fault: cfg.sigstopAtS === undefined ? null : { sigstop_at_s: cfg.sigstopAtS, sigstop_for_s: cfg.sigstopForS }, started_at: new Date(window.t0).toISOString() }, null, 2) + "\n",
  )
  note("window", { ...window, planned: true })

  // Fault injection (negative control): SIGSTOP the host by its exact pid, then SIGCONT. Only ever the host we started.
  if (cfg.sigstopAtS !== undefined) {
    void (async () => {
      await Bun.sleep(Math.max(0, window.measure_from + cfg.sigstopAtS! * 1000 - Date.now()))
      if (host.proc.exitCode !== null) return
      note("fault_sigstop", { pid: host.proc.pid, planned: true })
      process.kill(host.proc.pid, "SIGSTOP")
      await Bun.sleep(cfg.sigstopForS * 1000)
      process.kill(host.proc.pid, "SIGCONT")
      note("fault_sigcont", { pid: host.proc.pid, planned: true })
    })()
  }

  // Wait for the driver to finish its window and drain, an unplanned exit of the host, or a signal.
  const hostGone = host.proc.exited.then(() => "host_exit")
  const driverDone = driver.proc.exited.then(() => "driver_done")
  const signalWatch = (async () => {
    while (!signalled) await Bun.sleep(250)
    return "signal"
  })()
  const first = await Promise.race([hostGone, driverDone, signalWatch])
  note("run_end", { reason: first, signal: signalled, planned: true })
  if (first === "driver_done") await Bun.sleep(2000) // let the probe record the last ticks of the window
  if (first === "host_exit") exitCode = 2
} catch (error) {
  note("harness_error", { message: String(error instanceof Error ? error.message : error), planned: false })
  console.error(`harness error: ${error instanceof Error ? error.message : error}`)
  exitCode = 3
} finally {
  const dbBytes = [sb.db, sb.db + "-wal", sb.db + "-shm"].reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0)
  leftovers = (await teardown()) ?? []
  events.close()
  fs.writeFileSync(path.join(out, "final.json"), JSON.stringify({ db_bytes: dbBytes, leftovers, signal: signalled ?? null }, null, 2) + "\n")
  if (!cfg.keepSandbox) fs.rmSync(path.join(sb.root, "sbx"), { recursive: true, force: true })
}

const summary = summarizeRun(out)
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ ...summary, leftovers, run_dir: out }, null, 2) + "\n")
console.log(JSON.stringify({ verdict: summary.verdict, problems: summary.problems, criteria: summary.criteria.map((c) => ({ criterion: c.criterion, status: c.status, detail: c.detail })), driver_saturated: "driver_saturated" in summary ? summary.driver_saturated : undefined, leftovers: leftovers.length }, null, 2))
if (leftovers.length > 0) process.exit(4)
if (signalled) process.exit(signalled === "SIGINT" ? 130 : 143)
process.exit(exitCode !== 0 ? exitCode : { pass: 0, fail: 1, inconclusive: 2, invalid: 3 }[summary.verdict])
