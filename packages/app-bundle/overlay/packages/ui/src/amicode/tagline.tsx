import { createSignal, onCleanup, onMount } from "solid-js"

// amicode: the animated brand tagline — "Amico — " stays put while the suffix
// types itself out, holds, backspaces, and moves to the next phrase. Pure
// v2-token styling (dark/light correct); timings tuned to read, not distract.

export const TAGLINE_PHRASES = [
  "your research copilot",
  "runs experiments from a conversation",
  "remembers your results and context",
  "adapts to your workflow",
  "Andiamo.",
]

const TYPE_MS = 45
const DELETE_MS = 22
const HOLD_MS = 1700
const GAP_MS = 180

export function AmicodeTagline(props: { phrases?: string[]; "font-size"?: string }) {
  const phrases = () => props.phrases ?? TAGLINE_PHRASES
  const [text, setText] = createSignal(phrases()[0])
  const [blink, setBlink] = createSignal(true)

  onMount(() => {
    let phrase = 0
    let pos = phrases()[0].length
    let mode: "hold" | "delete" | "type" = "hold"
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      const current = phrases()[phrase % phrases().length]
      if (mode === "hold") {
        mode = "delete"
        timer = setTimeout(step, HOLD_MS)
        return
      }
      if (mode === "delete") {
        if (pos > 0) {
          pos -= 1
          setText(current.slice(0, pos))
          timer = setTimeout(step, DELETE_MS)
        } else {
          phrase += 1
          mode = "type"
          timer = setTimeout(step, GAP_MS)
        }
        return
      }
      const next = phrases()[phrase % phrases().length]
      if (pos < next.length) {
        pos += 1
        setText(next.slice(0, pos))
        timer = setTimeout(step, TYPE_MS)
      } else {
        mode = "hold"
        timer = setTimeout(step, HOLD_MS)
      }
    }
    timer = setTimeout(step, 700) // first cycle starts fast
    const cursor = setInterval(() => setBlink((b) => !b), 530)
    onCleanup(() => {
      if (timer) clearTimeout(timer)
      clearInterval(cursor)
    })
  })

  return (
    <span
      data-slot="amicode-tagline"
      style={{ "font-size": props["font-size"] ?? "14px", "line-height": "20px", color: "var(--v2-text-text-base)" }}
    >
      <span style={{ color: "var(--v2-text-text-accent)", "font-weight": "600" }}>Amico</span>
      {" — "}
      <span>{text()}</span>
      <span aria-hidden="true" style={{ color: "var(--v2-text-text-accent)", opacity: blink() ? "1" : "0" }}>
        ▍
      </span>
    </span>
  )
}
