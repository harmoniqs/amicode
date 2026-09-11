import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const SRC = readFileSync(join(__dirname, "use-composer-commands.tsx"), "utf-8")

describe("use-composer-commands keybind declarations (#878)", () => {
  test('agent.cycle is bound to "shift+tab", not "mod+." (the old Cmd+Period)', () => {
    const agentCycleBlock = SRC.match(/id:\s*"agent\.cycle"[\s\S]*?keybind:\s*"([^"]+)"/)
    expect(agentCycleBlock).toBeTruthy()
    expect(agentCycleBlock![1]).toBe("shift+tab")
    expect(SRC).not.toContain('"mod+."')
    expect(SRC).not.toContain('"mod."')
  })

  test('agent.cycle.reverse is explicitly disabled ("none")', () => {
    const reverseBlock = SRC.match(/id:\s*"agent\.cycle\.reverse"[\s\S]*?keybind:\s*"([^"]+)"/)
    expect(reverseBlock).toBeTruthy()
    expect(reverseBlock![1]).toBe("none")
  })

  test("no command in the file uses the mod+period keybind", () => {
    const modPeriodPattern = /keybind:\s*"[^"]*mod[+.]?\."[^"]*"/
    expect(modPeriodPattern.test(SRC)).toBe(false)
  })
})
