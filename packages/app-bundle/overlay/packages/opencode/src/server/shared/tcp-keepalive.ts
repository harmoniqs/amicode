// ── #1810: kernel-level corpse detection — SO_KEEPALIVE + TCP_USER_TIMEOUT ──
//
// The #1798 corpse class (half-dead sockets blocking fan-out writes) is
// detected today by application-level dead-men on a 60s cadence (#1757's
// upstream dead-man, the engine's bounded fan-out writer). This module is
// the layer-4 half: aggressive TCP keepalives (idle 30s, interval 5s, count 3
// → the OS reaps a FIN-less corpse in ≤45s) plus TCP_USER_TIMEOUT (~30s — a
// write to a socket whose data cannot drain ERRORS instead of blocking).
// Knobs are env-tunable; invalid values keep the briefed defaults.
//
// RUNTIME BOUNDARY (measured 2026-10-16, bun 1.4.2 — same family as the
// 2026-10-14 res.destroy-sends-no-FIN gap recorded in handlers/event.ts):
// raw node:net sockets under bun expose `_handle.fd` (a real kernel socket —
// full setsockopt surface), but bun's node:http server hands routes a
// NodeHTTPServerSocket whose native handle exposes NO fd and NO option
// surface, and its setKeepAlive() is a silent kernel no-op (verified with ss:
// no keepalive timer on the wire socket). Where the fd is unreachable the arm
// therefore degrades LOUDLY (once per process): the gap line names what is
// missing and what carries corpse detection instead (the bounded writer +
// the frontdoor's FIN discipline) — never a silent full skip.
import { dlopen, ptr } from "bun:ffi"

// Linux ABI socket option numbers (linux/tcp.h, asm-generic/socket.h). The
// engine's serving plane is hub-side Linux; platforms without a knob degrade
// per-knob (tcpKeepalivePlan) — keepalives only, never a crash.
const SOL_SOCKET = 1
const SO_KEEPALIVE = 9
const IPPROTO_TCP = 6

export interface TcpOptionNames {
  keepIdle: number
  keepIntvl: number
  keepCnt: number
  userTimeout: number
}

const linuxTcpOptions: TcpOptionNames = { keepIdle: 4, keepIntvl: 5, keepCnt: 6, userTimeout: 18 }

/** The portable plan: Linux arms both; anything else keepalives only. */
export function tcpKeepalivePlan(platform: string) {
  return { keepalives: true, userTimeout: platform === "linux" }
}

export interface KeepaliveKnobs {
  readonly keepIdleS: number
  readonly keepIntvlS: number
  readonly keepCnt: number
  readonly userTimeoutMs: number
}

const intKnob = (name: string, fallback: number, floor: number) => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= floor ? Math.floor(value) : fallback
}

/** Env-tunable knobs with the briefed defaults: idle 30s, interval 5s, count 3, user timeout 30s. */
export function tcpKeepaliveKnobs(): KeepaliveKnobs {
  return {
    keepIdleS: intKnob("AMICODE_TCP_KEEPIDLE_S", 30, 1),
    keepIntvlS: intKnob("AMICODE_TCP_KEEPINTVL_S", 5, 1),
    keepCnt: intKnob("AMICODE_TCP_KEEPCNT", 3, 1),
    userTimeoutMs: intKnob("AMICODE_TCP_USER_TIMEOUT_MS", 30_000, 1),
  }
}

// bun:ffi surface, loaded lazily on first arm: processes that never serve a
// socket (CLI, TUI) pay nothing, and platforms without libc.so.6 (darwin
// fleet clients) degrade per arm instead of crashing at import.
const ffiSymbols = () => {
  try {
    return dlopen("libc.so.6", {
      setsockopt: { args: ["i32", "i32", "i32", "pointer", "u32"], returns: "i32" },
      getsockopt: { args: ["i32", "i32", "i32", "pointer", "pointer"], returns: "i32" },
    }).symbols
  } catch {
    return undefined
  }
}
let ffi: ReturnType<typeof ffiSymbols> | undefined

const socketFd = (socket: unknown) => {
  const fd = (socket as { _handle?: { fd?: unknown } } | undefined)?._handle?.fd
  return typeof fd === "number" ? fd : undefined
}

const setInt = (fd: number, level: number, name: number, value: number) => {
  ffi ??= ffiSymbols()
  if (ffi === undefined) return false
  const buffer = new Int32Array([value])
  return ffi.setsockopt(fd, level, name, ptr(buffer), buffer.byteLength) === 0
}

const getInt = (fd: number, level: number, name: number) => {
  ffi ??= ffiSymbols()
  if (ffi === undefined) return undefined
  const value = new Int32Array(1)
  const length = new Int32Array([value.byteLength])
  const rc = ffi.getsockopt(fd, level, name, ptr(value), ptr(length))
  return rc === 0 ? value[0] : undefined
}

export interface KeepaliveReadback {
  keepalive: boolean
  keepIdleS: number
  keepIntvlS: number
  keepCnt: number
  userTimeoutMs: number
}

/**
 * Read the kernel's own socket options back (getsockopt) — the
 * assert-at-setup rule: never trust that a setter ran. Returns undefined
 * where the socket's fd is unreachable under this runtime. The option
 * numbers are the Linux ABI: meaningful on the hub-side Linux serving plane
 * (and in tests); not on platforms whose optnames differ.
 */
export function readTcpKeepalive(socket: unknown): KeepaliveReadback | undefined {
  const fd = socketFd(socket)
  if (fd === undefined) return undefined
  const keepalive = getInt(fd, SOL_SOCKET, SO_KEEPALIVE)
  const keepIdleS = getInt(fd, IPPROTO_TCP, linuxTcpOptions.keepIdle)
  const keepIntvlS = getInt(fd, IPPROTO_TCP, linuxTcpOptions.keepIntvl)
  const keepCnt = getInt(fd, IPPROTO_TCP, linuxTcpOptions.keepCnt)
  const userTimeoutMs = getInt(fd, IPPROTO_TCP, linuxTcpOptions.userTimeout)
  if (keepalive === undefined || keepIdleS === undefined || keepIntvlS === undefined || keepCnt === undefined) {
    return undefined
  }
  return { keepalive: keepalive === 1, keepIdleS, keepIntvlS, keepCnt, userTimeoutMs: userTimeoutMs ?? 0 }
}

export interface ArmReport {
  /** The socket's fd was reachable and the kernel-level arm ran. */
  fdArmed: boolean
  /** SO_KEEPALIVE landed on the kernel socket. */
  keepalive: boolean
  /** TCP_USER_TIMEOUT landed (Linux-only; false where the platform lacks it). */
  userTimeoutArmed: boolean
  /** No fd reachable — the node-API setKeepAlive fallback ran instead. */
  shimFallback: boolean
}

let keepaliveSink: (line: string) => void = (line) => console.error(line)

/** Test seam: capture the telemetry lines. */
export function setTcpKeepaliveSink(next: (line: string) => void) {
  keepaliveSink = next
}

/** Test seam: restore the production sink. */
export function resetTcpKeepaliveSink() {
  keepaliveSink = (line) => console.error(line)
}

// The runtime gap is a process-level property, not per-connection news: the
// gap line fires ONCE per process so a fleet of SSE connections cannot spam
// it (tests reset the limiter to pin the behavior deterministically).
let gapNoted = false

/** Test seam: re-arm the once-per-process gap line. */
export function resetTcpKeepaliveNotices() {
  gapNoted = false
}

/**
 * Arm kernel-level corpse detection on one socket at SSE connection setup.
 * SO_KEEPALIVE never degrades silently: a failed arm is loud every time. The
 * per-knob (and per-platform, via tcpKeepalivePlan) TCP_* degradations keep
 * keepalives armed at whatever the kernel supports. Never throws.
 */
export function armSseSocketKeepalive(
  socket: unknown,
  route: string,
  opts?: { options?: Partial<TcpOptionNames> },
): ArmReport {
  const options = { ...linuxTcpOptions, ...opts?.options }
  const knobs = tcpKeepaliveKnobs()
  const fd = socketFd(socket)
  const linuxAbi = tcpKeepalivePlan(process.platform).userTimeout
  if (fd === undefined || !linuxAbi) {
    // Two shapes share this branch, and neither may throw or skip silently:
    // (1) no reachable fd — bun's node:http shim (the measured gap above);
    // (2) a non-Linux platform, where the ABI optnames above do NOT apply
    //     (darwin's SO_KEEPALIVE/TCP_KEEPALIVE numbers differ) — the portable
    //     node-API setKeepAlive carries SO_KEEPALIVE + idle there.
    try {
      ;(socket as { setKeepAlive?: (enable: boolean, initialDelayMs: number) => void })?.setKeepAlive?.(
        true,
        knobs.keepIdleS * 1000,
      )
    } catch {
      /* the fallback must never break the connection */
    }
    if (fd === undefined) {
      if (!gapNoted) {
        gapNoted = true
        keepaliveSink(
          `SSE-KEEPALIVE-GAP route=${route} no reachable socket fd under this runtime ` +
            `(bun node:http shim) — SO_KEEPALIVE/TCP_USER_TIMEOUT NOT armed at the kernel; ` +
            `corpse detection rides the app-level bounded writer (#1798 phase C) and the ` +
            `frontdoor's FIN discipline`,
        )
      }
      return { fdArmed: false, keepalive: false, userTimeoutArmed: false, shimFallback: true }
    }
    keepaliveSink(
      `SSE-KEEPALIVE route=${route} fd=${fd} platform=${process.platform} ` +
        `keepalive=via-node-api idle_s=${knobs.keepIdleS} (TCP_* interval/count/user-timeout ` +
        `are Linux-ABI knobs — not applied on this platform)`,
    )
    return { fdArmed: false, keepalive: true, userTimeoutArmed: false, shimFallback: false }
  }
  if (!setInt(fd, SOL_SOCKET, SO_KEEPALIVE, 1)) {
    keepaliveSink(
      `SSE-KEEPALIVE-FAILED route=${route} fd=${fd} setsockopt(SO_KEEPALIVE) errored — ` +
        `corpse detection DEGRADED on this socket`,
    )
    return { fdArmed: false, keepalive: false, userTimeoutArmed: false, shimFallback: false }
  }
  // TCP_KEEPIDLE/KEEPINTVL take SECONDS; TCP_USER_TIMEOUT takes milliseconds.
  setInt(fd, IPPROTO_TCP, options.keepIdle, knobs.keepIdleS)
  setInt(fd, IPPROTO_TCP, options.keepIntvl, knobs.keepIntvlS)
  setInt(fd, IPPROTO_TCP, options.keepCnt, knobs.keepCnt)
  const userTimeoutArmed =
    tcpKeepalivePlan(process.platform).userTimeout && setInt(fd, IPPROTO_TCP, options.userTimeout, knobs.userTimeoutMs)
  // The telemetry line carries the KERNEL's read-back values, not the intent.
  const read = readTcpKeepalive(socket)
  keepaliveSink(
    `SSE-KEEPALIVE route=${route} fd=${fd} keepalive=${read?.keepalive ? 1 : 0} ` +
      `keepidle_s=${read?.keepIdleS ?? -1} keepintvl_s=${read?.keepIntvlS ?? -1} ` +
      `keepcnt=${read?.keepCnt ?? -1} user_timeout_ms=${read?.userTimeoutMs ?? -1}`,
  )
  return { fdArmed: true, keepalive: true, userTimeoutArmed, shimFallback: false }
}

export * as TcpKeepalive from "./tcp-keepalive"
