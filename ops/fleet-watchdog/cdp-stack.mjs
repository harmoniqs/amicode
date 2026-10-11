#!/usr/bin/env node
// cdp-stack.mjs — the #775 wedge's JS-stack capture (2026-10-04).
//
// The wedge: the engine's main thread spins (R-state, ~32% CPU) at LLM-stream
// start with the heap growing ~7 MB/s; log and HTTP go silent. Native gdb
// frames read ?? on the JIT-compiled binary — but bun's inspector (BUN_INSPECT,
// armed by amicode-server.sh) can PAUSE a spinning loop and report the exact
// wedging JS frames. This script is invoked by the watchdog's wedge capture
// (and by hand: node cdp-stack.mjs [port] [out-file]).
//
// Protocol: CDP over the inspector websocket. We Debugger.enable, then
// Debugger.pause — the Inspector delivers Debugger.paused with callFrames.
// For a spinning loop the pause lands mid-spin: THE money shot. If the loop
// is interrupt-guarded the pause may take a moment; bounded by --timeout.
//
// Node >= 21 (built-in WebSocket). Zero dependencies — the hub runs stock node.
const port = process.argv[2] ?? "9229"
const outFile = process.argv[3] ?? process.env.CDP_STACK_OUT ?? "/tmp/cdp-stack.json"
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 25000)

const target = `http://127.0.0.1:${port}`

async function main() {
  // The inspector's discovery endpoint lists the inspectable contexts.
  const list = await fetch(`${target}/json/list`).then((r) => r.json())
  const page = Array.isArray(list) ? list[0] : list
  if (!page?.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl in /json/list")

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  let paused = undefined

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined) {
      pending.get(msg.id)?.resolve(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === "Debugger.paused") paused = msg.params
  })

  const opened = new Promise((res, rej) => {
    ws.addEventListener("open", res)
    ws.addEventListener("error", rej)
  })
  await opened

  await send("Debugger.enable")
  // Request the pause; the paused event carries the frames.
  const pauseReq = send("Debugger.pause").catch(() => undefined)
  const deadline = Date.now() + TIMEOUT_MS
  while (paused === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await pauseReq

  const out = {
    captured_at: new Date().toISOString(),
    paused: paused ?? null,
    note: paused ? undefined : "no Debugger.paused within timeout (loop may be interrupt-starved)",
  }
  const text = JSON.stringify(out, null, 2)
  process.stdout.write(text + "\n")
  const fs = await import("node:fs")
  fs.writeFileSync(outFile, text)
  try {
    await send("Debugger.resume")
  } catch {
    /* already gone */
  }
  ws.close()
}

main().catch((err) => {
  process.stderr.write(`cdp-stack failed: ${err}\n`)
  process.exit(1)
})

