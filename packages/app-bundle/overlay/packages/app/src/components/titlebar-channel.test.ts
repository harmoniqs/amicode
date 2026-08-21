import { describe, expect, test } from "bun:test"
import { channelBadgeText } from "./titlebar-channel"

describe("channelBadgeText", () => {
  test("returns DEV when developer mode is enabled, regardless of channel", () => {
    expect(channelBadgeText("beta", true)).toBe("DEV")
    expect(channelBadgeText("dev", true)).toBe("DEV")
    expect(channelBadgeText("prod", true)).toBe("DEV")
  })

  test("returns BETA on beta or dev channel when developer mode is off", () => {
    expect(channelBadgeText("beta", false)).toBe("BETA")
    expect(channelBadgeText("dev", false)).toBe("BETA")
  })

  test("returns null on prod channel when developer mode is off", () => {
    expect(channelBadgeText("prod", false)).toBeNull()
  })
})
