import { describe, expect, test } from "bun:test"
import { webZoom, setWebZoom } from "../utils/web-zoom"

// harmoniqs/amicode#266 — Cmd/Ctrl +/- zoom did nothing in the webview.
//
// The zoom commands, their CSS-zoom implementation, and the platform signal
// all existed and were correct. Only the wiring was wrong: the chords were
// registered with the command registry's exact (normalized-key, modifier-
// mask) lookup with no fallback, and only "mod+=" / "mod+-" were
// registered — which misses what a user actually presses:
//   Ctrl+Plus on a US layout IS Ctrl+Shift+"=", which arrives as key "+"
//   (normalized "plus") WITH the shift bit — wrong key AND wrong mask.
//   The numpad's "+" arrives unshifted. On DE/FR/Nordic layouts "=" is
//   itself a shifted key, so even the canonical chord carries shift.
//
// So the bare chord worked only on a US layout with the main-row "=", which
// is why this survived: it works for whoever tries it that one way.
//
// V1 (this file): the registry no longer owns zoom. web-zoom.ts (imported
// below — module scope registers the capture listener on document) grabs the
// raw chords by the key the layout PRODUCES — the same physical key yields
// one of "="/"+"/"-"/"_" on every layout — so the coverage matrix below
// asserts every variant that can arrive, plus the negatives that must never
// fire.

function chord(key: string, opts: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
  // cancelable: real keydown events are cancelable; without it preventDefault
  // (and defaultPrevented) are no-ops per spec.
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    cancelable: true,
  })
}

function press(ev: KeyboardEvent) {
  document.dispatchEvent(ev)
  return webZoom()
}

describe("zoom raw chord capture (amicode#266)", () => {
  test("zoom in: main-row =, US Ctrl+Plus, numpad +, and shifted-= layouts", () => {
    for (const [key, shift] of [
      ["=", false],
      ["+", true], // US Ctrl+Plus: shift+"=" surfaces as "+" with the shift bit
      ["+", false], // numpad plus
      ["=", true], // layouts where "=" itself requires shift (DE/FR/Nordic)
    ] as const) {
      setWebZoom(1)
      const zoom = press(chord(key, { ctrl: true, shift }))
      expect(zoom).toBe(1.1)
    }
  })

  test("zoom out: main-row - and the shifted underscore", () => {
    for (const [key, shift] of [
      ["-", false],
      ["_", true],
    ] as const) {
      setWebZoom(1)
      const zoom = press(chord(key, { ctrl: true, shift }))
      expect(zoom).toBe(0.9)
    }
  })

  test("zoom reset: a single unambiguous chord", () => {
    setWebZoom(1.5)
    expect(press(chord("0", { ctrl: true }))).toBe(1)
  })

  test("Cmd (meta) drives the same chords", () => {
    for (const [key, expected] of [
      ["=", 1.1],
      ["-", 0.9],
      ["0", 1],
    ] as const) {
      setWebZoom(1)
      expect(press(chord(key, { meta: true }))).toBe(expected)
    }
  })

  test("nothing fires without a modifier", () => {
    for (const key of ["=", "+", "-", "_", "0"]) {
      setWebZoom(1)
      expect(press(chord(key))).toBe(1)
      expect(press(chord(key, { shift: true }))).toBe(1)
    }
  })

  test("other Ctrl chords are untouched", () => {
    for (const [key, shift] of [
      ["w", false],
      ["p", false],
      ["p", true],
      ["a", false],
      ["1", false],
      ["ArrowUp", false],
    ] as const) {
      setWebZoom(1)
      expect(press(chord(key, { ctrl: true, shift }))).toBe(1)
    }
  })

  test("matched chords are consumed, unmatched chords are not", () => {
    const matched = chord("=", { ctrl: true })
    document.dispatchEvent(matched)
    expect(matched.defaultPrevented).toBe(true)

    const unmatched = chord("p", { ctrl: true })
    document.dispatchEvent(unmatched)
    expect(unmatched.defaultPrevented).toBe(false)
  })
})
