import { createSignal, onCleanup, onMount } from "solid-js"
import { Mark } from "../components/logo"

// amicode: boot splash — the Mark above a mono line of Piccolo code typing
// itself in and backspacing out (the harmoniqs.ai motif). Shown only while the
// app boots, so timings run brisk; v2 tokens keep it dark/light correct.

const CODE_LINES = [
  "sys = TransmonSystem(ω = 5.0, δ = -0.3)",
  "qcp = SmoothPulseProblem(sys, :X, T = 10.0)",
  "solve!(qcp; max_iter = 60)",
  "F = 0.99999  ✓",
]

export function AmicodeSplash(props: { class?: string }) {
  const [text, setText] = createSignal("")
  const [blink, setBlink] = createSignal(true)

  onMount(() => {
    let line = 0
    let pos = 0
    let mode: "type" | "hold" | "delete" = "type"
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      const current = CODE_LINES[line % CODE_LINES.length]
      if (mode === "type") {
        if (pos < current.length) {
          pos += 1
          setText(current.slice(0, pos))
          timer = setTimeout(step, 22)
        } else {
          mode = "hold"
          timer = setTimeout(step, 650)
        }
        return
      }
      if (mode === "hold") {
        mode = "delete"
        timer = setTimeout(step, 40)
        return
      }
      if (pos > 0) {
        pos -= 1
        setText(current.slice(0, pos))
        timer = setTimeout(step, 11)
      } else {
        line += 1
        mode = "type"
        timer = setTimeout(step, 120)
      }
    }
    timer = setTimeout(step, 150)
    const cursor = setInterval(() => setBlink((b) => !b), 500)
    onCleanup(() => {
      if (timer) clearTimeout(timer)
      clearInterval(cursor)
    })
  })

  return (
    <div
      data-component="amicode-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "16px" }}
    >
      <Mark class="w-16 h-auto" />
      <div
        style={{
          "font-family": "var(--font-family-mono, ui-monospace, monospace)",
          "font-size": "13px",
          "min-height": "18px",
          "min-width": "340px",
          "text-align": "center",
          color: "var(--v2-text-text-muted)",
          "white-space": "pre",
        }}
      >
        {text()}
        <span aria-hidden="true" style={{ color: "var(--v2-icon-icon-accent)", opacity: blink() ? "1" : "0" }}>
          ▍
        </span>
      </div>
      <div style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>Amicode · By Harmoniqs</div>
    </div>
  )
}
