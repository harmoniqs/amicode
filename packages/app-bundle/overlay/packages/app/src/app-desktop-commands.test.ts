import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const appSource = readFileSync(join(import.meta.dir, "app.tsx"), "utf8")

describe("DesktopCommands agent-cycle bridge (amicode#878)", () => {
  test("DesktopCommands listens for agent-cycle messages from the extension", () => {
    expect(appSource).toContain('"agent-cycle"')
    expect(appSource).toContain('"amicode"')
  })

  test("the handler triggers the agent.cycle command", () => {
    const handlerBlock = appSource.match(
      /kind.*===.*"agent-cycle"[\s\S]{0,200}?trigger\(\s*"([^"]+)"/,
    )
    expect(handlerBlock).toBeTruthy()
    expect(handlerBlock![1]).toBe("agent.cycle")
  })

  test("the handler is gated on being inside a frame (window.parent !== window)", () => {
    expect(appSource).toContain("window.parent !== window")
  })

  test("the handler cleans up on component disposal", () => {
    expect(appSource).toContain("removeEventListener")
  })
})
