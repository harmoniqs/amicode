// #1745: always-on client telemetry — the error capture + liveness heartbeat.
//
// This capture used to live inside the #1290 debug badge, which mounts only
// when a per-origin localStorage flag is set. The 2026-09-19 origin shift to
// :4097 gave every fleet client a fresh origin (empty localStorage), the flag
// went unset, the badge never mounted — and client-errors.log went silent for
// six weeks (Sep 23 → Oct 10) while panel-side failures piled up unlogged.
// Telemetry that depends on a diagnostic opt-in is not telemetry; it mounts
// unconditionally from the app root.
//
// Contract:
//  - fire-and-forget: never blocks panel rendering, failures swallowed.
//  - the target is the SERVING origin: a root-relative fetch resolves against
//    the document's URL, so it reaches the frontdoor's /__amicode_client_log
//    in every serving topology (4096/4097, a tunnel with a path prefix).
//    dataUrl()-style bases (the SDK's server URL) are NOT the serving origin —
//    the #1294 era had them pointing at the authenticated service (401s), and
//    September boot diagnostics show text/html answers.
//  - no PII: the heartbeat is exactly {"heartbeat": <epoch ms>}.

/** One fire-and-forget POST to the hub's client-error log (the frontdoor
 *  appends to client-errors.log and answers 204). */
export function postClientLog(body: string) {
  try {
    void fetch("/__amicode_client_log", { method: "POST", body }).catch(() => {})
  } catch {}
}

let lastClientError = ""

/** The newest captured error text (for the #1290 badge's display). */
export function getLastClientError() {
  return lastClientError
}

const HEARTBEAT_MS = 60_000

/** Install the capture (console.error + window error + unhandled rejections)
 *  and the liveness heartbeat (immediately, then every ~60s). Returns a
 *  cleanup that uninstalls everything. */
export function startClientTelemetry(opts?: { heartbeatMs?: number }): () => void {
  const entry = performance
    .getEntriesByType("resource")
    .map((r) => r.name)
    .find((n) => n.includes("index-") && n.endsWith(".js"))
  const build = entry ? entry.split("/").pop()!.replace("index-", "").replace(".js", "") : "?"
  // #1290: Solid routes unhandled reactive errors through console.error, NOT
  // window.onerror — the teardown error behind the blank was never visible to
  // the window capture. Intercept console.error too.
  const shipped = new Set<string>()
  const ship = (kind: string, text: string, stack = "") => {
    if (shipped.has(text)) return
    shipped.add(text)
    postClientLog(`${kind} ${build}\n${text.slice(0, 600)}\n${stack.slice(0, 400)}`)
  }
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    const first = args.find((a) => a instanceof Error) ?? args[0]
    const text = String(first instanceof Error ? first.message : (first as unknown))
    if (!text.includes("ResizeObserver loop")) {
      lastClientError = `${text.slice(0, 80)}`
      ship("C", text, first instanceof Error ? String(first.stack ?? "") : "")
    }
    originalError(...(args as Parameters<typeof console.error>))
  }
  const onWindowError = (e: ErrorEvent) => {
    lastClientError = `E:${(e.message || "unknown").slice(0, 70)}`
    ship("E", `${e.message ?? "unknown"}`, String((e.error as Error | undefined)?.stack ?? ""))
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    lastClientError = `R:${String(e.reason).slice(0, 70)}`
    ship("R", String(e.reason), e.reason instanceof Error ? String(e.reason.stack ?? "") : "")
  }
  window.addEventListener("error", onWindowError)
  window.addEventListener("unhandledrejection", onRejection)
  // #1745: the liveness canary — beat immediately (an open panel must never
  // look "never heartbeated" to the frontdoor's silence alarm), then on the
  // interval. The frontdoor alarms when live SSE streams exist but no
  // heartbeat arrived within its threshold window.
  const beat = () => postClientLog(`{"heartbeat":${Date.now()}}`)
  beat()
  const heartbeat = setInterval(beat, opts?.heartbeatMs ?? HEARTBEAT_MS)
  return () => {
    console.error = originalError
    window.removeEventListener("error", onWindowError)
    window.removeEventListener("unhandledrejection", onRejection)
    clearInterval(heartbeat)
  }
}
