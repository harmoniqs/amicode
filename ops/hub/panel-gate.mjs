// panel-gate.mjs — the panel render gate (#1804). Dead-widgets-zero or the
// dist does not ship.
//
// 2026-10-15, Aaron's directive: three times the user rejected a dist whose
// surfaces rendered without live data, and the deploy gates never caught it
// because they measured what the TREE contains, never what the PANEL renders.
// This module is the binding: after any dist swap, boot the real panel through
// the frontdoor, let it settle, and assert —
//   (1) the composer renders (the panel is usable at all);
//   (2) zero elements stuck in a loading/spinner state past the settle window
//       (a dead widget is a spinner that never resolves: "renders data or
//       renders nothing" — never "renders waiting forever");
//   (3) no per-URL request rate above 1/s in any sliding second (the poll-loop
//       signature of a widget hammering a route that never answers);
//   (4) every 4xx/5xx response belongs to the documented honest-absence
//       allowlist, reason-checked ({"ok":false,"reason":"no-fleet-peers"} and
//       the extension's own no-route 404 for routes the app never calls) —
//       an UNEXPLAINED 4xx/5xx from a shipped surface fails the gate.
//
// Exit 0 = the panel gate passes (the dist may ship). Anything else = STOP.
//
// Runs headless via the panel-probe harness (playwright-core) on the client
// machine, driven by ops/hub/deploy-gate.sh over ssh — this file is
// repo-owned; the gate script ships it to the harness before each run.

import { chromium } from "playwright-core"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// The harness's known headless shell path (see sibling probes).
const shell =
  process.env.PANEL_GATE_SHELL ??
  homedir() +
    "/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell"

const origin = process.env.PANEL_GATE_ORIGIN ?? "http://127.0.0.1:4097/"
const settleMs = Number(process.env.PANEL_GATE_SETTLE_MS ?? 30_000)
const RATE_CAP_PER_S = 1
const RATE_WINDOW_MS = 1_000

if (!existsSync(shell)) {
  console.error("PANEL-GATE: headless shell not found at " + shell)
  process.exit(2)
}

// ── the honest-absence allowlist ─────────────────────────────────────────────
// A 4xx/5xx passes the gate ONLY if its body carries a documented reason.
// The no-fleet-peers absence (#1768) is the hub's designed silent fallback; a
// bare 404 from a shipped surface is a dead widget and fails.
const OK_ABSENCE_REASONS = new Set(["no-fleet-peers"])

// ── run ─────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: shell, headless: true })
const page = await browser.newPage()

const failures = []
const fail = (why) => failures.push(why)

const reqs = [] // { url, t }
const responses = [] // { url, status, body? }
page.on("request", (r) => reqs.push({ url: r.url(), t: Date.now() }))
page.on("response", async (r) => {
  const entry = { url: r.url(), status: r.status() }
  if (r.status() >= 400 && r.url().includes("/amicode/")) {
    try {
      entry.body = (await r.text()).slice(0, 200)
    } catch {}
  }
  responses.push(entry)
})
page.on("pageerror", (e) => fail(`page error: ${e.message.slice(0, 160)}`))

console.log(`PANEL-GATE: booting ${origin}`)
await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 })
await page.waitForTimeout(settleMs)

// (1) the composer renders — the panel is usable.
const composer = await page.evaluate(() => {
  const el = document.querySelector("textarea, [contenteditable=true], [data-composer]")
  return el !== null && el.offsetParent !== null
})
if (!composer) fail("composer did not render (no visible textarea/contenteditable after settle)")

// (2) zero stuck spinners past the settle window — a surface renders data or
// renders nothing; never waiting forever. Spinner classes are drawn from the
// app's loading states (animate-spin / skeleton / loading / spinner families).
const stuck = await page.evaluate(() => {
  const sel = [
    "[class*='animate-spin']",
    "[class*='spinner']",
    "[class*='skeleton']",
    "[data-loading='true']",
    "[aria-busy='true']",
  ].join(",")
  return [...document.querySelectorAll(sel)]
    .filter((el) => el.offsetParent !== null)
    .slice(0, 5)
    .map((el) => el.className.toString().slice(0, 80))
})
if (stuck.length > 0) fail(`loading state(s) stuck past the settle window: ${JSON.stringify(stuck)}`)

// (3) no poll loop: per-URL rate in any sliding 1s window <= RATE_CAP_PER_S.
const perUrl = new Map()
for (const { url, t } of reqs) {
  if (!perUrl.has(url)) perUrl.set(url, [])
  perUrl.get(url).push(t)
}
for (const [url, ts] of perUrl) {
  ts.sort((a, b) => a - b)
  for (let i = 0; i + RATE_CAP_PER_S + 1 < ts.length; i++) {
    const j = i + RATE_CAP_PER_S + 1
    if (ts[j] - ts[i] < RATE_WINDOW_MS) {
      fail(`poll loop: ${url} — ${ts.length} requests, >${RATE_CAP_PER_S}/s in a sliding second`)
      break
    }
  }
}

// (4) every 4xx/5xx is a documented honest absence, reason-checked.
for (const r of responses.filter((r) => r.status >= 400)) {
  let reason = ""
  try {
    reason = JSON.parse(r.body ?? "{}").reason ?? ""
  } catch {}
  if (!OK_ABSENCE_REASONS.has(reason)) {
    fail(`unexplained ${r.status} from a shipped surface: ${r.url.slice(0, 140)} body=${(r.body ?? "").slice(0, 80)}`)
  }
}

await browser.close()

// ── verdict ─────────────────────────────────────────────────────────────────
const totalReqs = reqs.length
console.log(`PANEL-GATE: ${totalReqs} requests, ${responses.filter((r) => r.status >= 400).length} 4xx/5xx responses`)
if (failures.length === 0) {
  console.log("PANEL-GATE: PASS — composer rendered, zero stuck spinners, no poll loops, all absences documented")
  process.exit(0)
}
for (const f of failures) console.error("PANEL-GATE FAIL: " + f)
console.error("PANEL-GATE: FAIL — the dist does not ship. Acceptance is what the panel renders.")
process.exit(1)
