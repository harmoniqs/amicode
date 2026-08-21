import { describe, expect, test } from "bun:test"
import { clampShellLabel, shellRowLabel, SHELL_ROW_MAX } from "./shell-row"

// Regression coverage for "a constant error not going away" (2026-07-29).
//
// A PENDING bash part has no `input.command` yet, so the label chain fell through
// to the model's free-text `description` and rendered a full prose sentence where
// users read a command — for the whole duration of the command. The text happened
// to paraphrase agent guidance about local launches being refused, so it read as a
// hard failure while the solve underneath was healthy and on iteration 29.
const REPORTED =
  '"A local launch is REFUSED by amico-run while this solver is selected (exit 64), so attempting one only wastes a turn."'

describe("shell row label", () => {
  test("the reported case no longer fills the row, and loses its quote", () => {
    const out = shellRowLabel({ state: { input: { description: REPORTED } } })
    expect(out.length).toBeLessThanOrEqual(SHELL_ROW_MAX)
    expect(out.startsWith('"')).toBe(false)
    expect(out.endsWith("…")).toBe(true)
  })

  test("the real command always wins over title and description", () => {
    expect(
      shellRowLabel({ state: { title: "Some title", input: { command: "ls -la", description: "listing files" } } }),
    ).toBe("ls -la")
  })

  test("falls back to title, then description — both still useful", () => {
    expect(shellRowLabel({ state: { title: "Install deps" } })).toBe("Install deps")
    expect(shellRowLabel({ state: { input: { description: "Install deps" } } })).toBe("Install deps")
  })

  test("a short description is untouched — the fallback keeps its value", () => {
    expect(shellRowLabel({ state: { input: { description: "Run the tests" } } })).toBe("Run the tests")
  })

  test("first line only, and blanks do not win", () => {
    expect(shellRowLabel({ state: { input: { command: "  make build  \n&& make test" } } })).toBe("make build")
    // an empty string must not beat a usable description
    expect(shellRowLabel({ state: { input: { command: "   ", description: "Install deps" } } })).toBe("Install deps")
  })

  test("nothing usable → the neutral placeholder, never a throw", () => {
    expect(shellRowLabel({})).toBe("command")
    expect(shellRowLabel({ state: {} })).toBe("command")
    expect(shellRowLabel({ state: { input: {} } })).toBe("command")
  })

  test("clamping is exact and elides rather than truncating silently", () => {
    const long = "x".repeat(SHELL_ROW_MAX + 20)
    const out = clampShellLabel(long)
    expect(out.length).toBe(SHELL_ROW_MAX)
    expect(out.endsWith("…")).toBe(true)
    expect(clampShellLabel("x".repeat(SHELL_ROW_MAX))).toBe("x".repeat(SHELL_ROW_MAX))
  })

  test("single-quoted prose is unwrapped too", () => {
    expect(clampShellLabel("'Install the dependencies'")).toBe("Install the dependencies")
  })
})
