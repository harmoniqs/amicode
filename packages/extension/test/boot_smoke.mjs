#!/usr/bin/env node
// β.2 boot-smoke gate (spec §5): the VENDORED opencode binary must serve
// GET /event as an SSE stream (HTTP 200, text/event-stream) against a
// synthesized project, with no LLM creds. Exit 0 = pass.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const key = `${process.platform}-${process.arch}`
const bin = join(PKG_ROOT, 'vendor', 'opencode', key, 'opencode')

const fail = (msg, code = 1) => { console.error(`[smoke] FAIL: ${msg}`); process.exit(code) }

if (!existsSync(bin)) fail(`vendored binary missing at ${bin} — run \`pnpm --filter amicode-v2 fetch:opencode\``, 10)

// Synthesize a minimal opencode project (inline port of the spike's prepareOpencodeProject).
const proj = mkdtempSync(join(tmpdir(), 'amicode-smoke-'))
mkdirSync(join(proj, '.opencode'), { recursive: true })
writeFileSync(join(proj, 'AGENTS.md'), '# Amicode boot smoke\n')
writeFileSync(join(proj, '.opencode', 'opencode.json'),
  JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2))

const port = await new Promise((res, rej) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)) })
  srv.on('error', rej)
})

console.log(`[smoke] spawning ${bin} serve --port ${port}`)
let done = false
let serverLog = ''
const child = spawn(bin, ['serve', '--port', String(port)], { cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] })
child.on('error', e => fail(`spawn failed: ${e.message}`))
child.stdout.on('data', d => { serverLog += d })
child.stderr.on('data', d => { serverLog += d })
child.on('exit', (c, s) => { if (!done) fail(`opencode exited early (code=${c} signal=${s})\n--- server output ---\n${serverLog}`) })

// Poll until the server answers, 30s cap.
const deadline = Date.now() + 30_000
let up = false
while (Date.now() < deadline && !up) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    if (r.status < 500) up = true
  } catch { /* not up yet */ }
  if (!up) await new Promise(r => setTimeout(r, 200))
}
if (!up) { done = true; child.kill('SIGKILL'); fail(`server not up within 30s\n--- server output ---\n${serverLog}`) }

// THE gate: /event answers 200 with an SSE content-type. fetch resolves on
// headers (the SSE body streaming doesn't block us); 10s cap so a header-less
// hang fails fast instead of eating the CI job timeout.
const ctrl = new AbortController()
const gateTimer = setTimeout(() => ctrl.abort(), 10_000)
const ev = await fetch(`http://127.0.0.1:${port}/event`, { signal: ctrl.signal })
clearTimeout(gateTimer)
const ctype = ev.headers.get('content-type') ?? ''
console.log(`[smoke] GET /event → ${ev.status} (${ctype})`)
if (ev.status !== 200) { done = true; child.kill('SIGKILL'); fail(`/event status ${ev.status}, want 200`) }
if (!ctype.includes('text/event-stream')) { done = true; child.kill('SIGKILL'); fail(`/event content-type "${ctype}", want text/event-stream`) }
ctrl.abort()

// Clean shutdown: SIGTERM, exit within 5s.
done = true
const exited = new Promise(res => child.on('exit', res))
child.kill('SIGTERM')
const t = setTimeout(() => child.kill('SIGKILL'), 5_000)
await exited
clearTimeout(t)
console.log('[smoke] PASS')
