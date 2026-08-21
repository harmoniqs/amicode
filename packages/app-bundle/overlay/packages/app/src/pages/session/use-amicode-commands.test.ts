import { describe, expect, spyOn, test } from "bun:test"
import { inAmicode, postAmicode } from "./use-amicode-commands"

// The entity rail's pulse chip (its one inspector entry) and the Amico command
// palette both reach the VS Code extension through postAmicode(). chat_panel.ts relays the
// envelope to the host and executes ONLY commands on its BRIDGE_ALLOWED_COMMANDS
// allowlist — so the exact envelope shape and command string are a contract.
describe("postAmicode bridge envelope", () => {
  test('posts {source:"amicode", kind:"command", command} to window.parent with "*"', () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      postAmicode("amicode.openInspector")
      expect(spy).toHaveBeenCalledTimes(1)
      // Cast past the DOM postMessage overloads (which type arg 2 as
      // WindowPostMessageOptions) — postAmicode passes a legacy string origin.
      const [message, targetOrigin] = spy.mock.calls[0] as unknown as [unknown, unknown]
      expect(message).toEqual({ source: "amicode", kind: "command", command: "amicode.openInspector" })
      // Post to any origin — chat_panel.ts pins the origin on the receiving side.
      expect(targetOrigin).toBe("*")
    } finally {
      spy.mockRestore()
    }
  })

  test("never throws even if the parent frame rejects the post", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {
      throw new Error("no parent")
    })
    try {
      expect(() => postAmicode("amicode.openInspector")).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

// inAmicode() gates the button (and the palette ops) so they never render in the
// public web / share build, where there is no extension host to relay to. In a
// non-framed context self === top, so it must report false.
describe("inAmicode gate", () => {
  test("false when not framed (self === top)", () => {
    expect(inAmicode()).toBe(false)
  })
})
