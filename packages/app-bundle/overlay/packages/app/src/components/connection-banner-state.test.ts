import { describe, expect, test } from "bun:test"
import {
  DOWN_GRACE_MS,
  RECONNECT_FLASH_MS,
  computeBannerState,
  type BannerInput,
} from "./connection-banner-state"

const T0 = 1_000_000

function input(overrides: Partial<BannerInput>): BannerInput {
  return {
    status: "connected",
    connectedOnce: true,
    downSince: null,
    recoveredAt: null,
    now: T0,
    ...overrides,
  }
}

describe("computeBannerState — the silence law (#653)", () => {
  test("boot transient: never connected → silent even while disconnected", () => {
    expect(computeBannerState(input({ status: "disconnected", connectedOnce: false, downSince: T0 - 60_000, now: T0 })).mode).toBe("silent")
  })

  test("a brief blip (down < grace) is silent — no flash, no restart", () => {
    expect(computeBannerState(input({ status: "disconnected", downSince: T0 - (DOWN_GRACE_MS - 1), now: T0 }))).toEqual({
      mode: "silent",
      showRestart: false,
    })
  })

  test("down exactly at the grace boundary surfaces the banner with Restart", () => {
    const s = computeBannerState(input({ status: "disconnected", downSince: T0 - DOWN_GRACE_MS, now: T0 }))
    expect(s.mode).toBe("down")
    expect(s.showRestart).toBe(true)
  })

  test("a long outage stays down", () => {
    const s = computeBannerState(input({ status: "disconnected", downSince: T0 - DOWN_GRACE_MS * 7, now: T0 }))
    expect(s.mode).toBe("down")
    expect(s.showRestart).toBe(true)
  })

  test("a blip's recovery is silent (no reconnected flash)", () => {
    const s = computeBannerState(
      input({ status: "connected", downSince: T0 - 3_000, recoveredAt: T0, now: T0 }),
    )
    expect(s.mode).toBe("silent")
    expect(s.showRestart).toBe(false)
  })

  test("recovery after a persistent outage flashes reconnected for the flash window", () => {
    const s = computeBannerState(
      input({ status: "connected", downSince: T0 - DOWN_GRACE_MS - 5_000, recoveredAt: T0, now: T0 }),
    )
    expect(s.mode).toBe("reconnected")
    expect(s.showRestart).toBe(false)
  })

  test("the recovery flash expires", () => {
    const s = computeBannerState(
      input({ status: "connected", downSince: T0 - DOWN_GRACE_MS - 5_000, recoveredAt: T0 - RECONNECT_FLASH_MS, now: T0 }),
    )
    expect(s.mode).toBe("silent")
  })

  test("plain connected with no outage history is silent", () => {
    expect(computeBannerState(input({})).mode).toBe("silent")
  })

  test("disconnected with no spell stamp (pre-effect ordering) is silent, not down", () => {
    expect(computeBannerState(input({ status: "disconnected", downSince: null, now: T0 })).mode).toBe("silent")
  })
})
