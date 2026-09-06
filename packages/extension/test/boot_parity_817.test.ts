// Issue #817 — D3 client-side (spec spec-20260905-045114-session-device-
// lifecycle, revised placement): at boot the client checks the SERVER-REPORTED
// version against the release channel and records the outcome. The check
// fails OPEN when the channel is unreachable — but records a distinct
// outcome, so an assertion that never ran is never mistaken for one that
// passed: parity-ok | parity-drift | channel-unreachable.
import { describe, expect, test } from "vitest"
import {
  parityOutcome,
  checkParity,
  recordBootParity,
  fetchCanonicalReleaseChannel,
} from "../../app-bundle/overlay/packages/app/src/utils/boot-parity"

describe("parityOutcome (the comparison core)", () => {
  test("a server version matching the channel is parity-ok", () => {
    expect(parityOutcome({ serverVersion: "v1.18.29", channelVersion: "v1.18.29" })).toBe("parity-ok")
  })

  test("comparison is on the release identity, tolerant of the v prefix and whitespace", () => {
    expect(parityOutcome({ serverVersion: "1.18.29", channelVersion: "v1.18.29" })).toBe("parity-ok")
    expect(parityOutcome({ serverVersion: " v1.18.29 ", channelVersion: "v1.18.29" })).toBe("parity-ok")
  })

  test("a server version differing from the channel is parity-drift (the lagging-hub incident)", () => {
    expect(parityOutcome({ serverVersion: "v1.18.10-amicode.21", channelVersion: "v1.18.29" })).toBe("parity-drift")
  })

  test("a server that reports no version can never be asserted ok", () => {
    expect(parityOutcome({ serverVersion: undefined, channelVersion: "v1.18.29" })).toBe("parity-drift")
    expect(parityOutcome({ serverVersion: "", channelVersion: "v1.18.29" })).toBe("parity-drift")
  })

  test("a channel with no releasable version can never be asserted ok either", () => {
    expect(parityOutcome({ serverVersion: "v1.18.29", channelVersion: undefined })).toBe("parity-drift")
    expect(parityOutcome({ serverVersion: "v1.18.29", channelVersion: "" })).toBe("parity-drift")
  })
})

describe("checkParity (fail-open, three-outcome record)", () => {
  test("an unreachable channel records channel-unreachable and fails open — never a fake ok", async () => {
    const outcome = await checkParity({
      serverVersion: "v1.18.29",
      channel: async () => {
        throw new Error("HTTP 404")
      },
    })
    expect(outcome.outcome).toBe("channel-unreachable")
    expect(outcome.detail).toContain("404")
  })

  test("a reachable channel yields the compared outcome", async () => {
    const drifted = await checkParity({ serverVersion: "v1.18.10", channel: async () => "v1.18.29" })
    expect(drifted.outcome).toBe("parity-drift")
    expect(drifted.channelVersion).toBe("v1.18.29")

    const ok = await checkParity({ serverVersion: "v1.18.29", channel: async () => "v1.18.29" })
    expect(ok.outcome).toBe("parity-ok")
  })

  test("the record is a fact: it carries what was compared", async () => {
    const record = await checkParity({ serverVersion: "v1.18.10", channel: async () => "v1.18.29" })
    expect(record).toMatchObject({
      outcome: "parity-drift",
      serverVersion: "v1.18.10",
      channelVersion: "v1.18.29",
    })
    const unreachable = await checkParity({
      serverVersion: "v1.18.10",
      channel: async () => {
        throw new Error("no network")
      },
    })
    expect(unreachable.serverVersion).toBe("v1.18.10")
    expect(unreachable.channelVersion).toBeUndefined()
  })
})

describe("recordBootParity (the boot assertion: logged, never a gate)", () => {
  test("records the outcome against the canonical release channel and logs it once", async () => {
    const lines: string[] = []
    const record = await recordBootParity({
      serverVersion: "v1.18.10",
      fetcher: (async () =>
        Response.json({ tag_name: "v1.18.29" })) as unknown as typeof fetch,
      log: (line) => lines.push(line),
    })
    expect(record.outcome).toBe("parity-drift")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("parity-drift")
    expect(lines[0]).toContain("v1.18.10")
  })

  test("an unreachable channel logs channel-unreachable — never a silent pass", async () => {
    const lines: string[] = []
    const record = await recordBootParity({
      serverVersion: "v1.18.29",
      fetcher: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      log: (line) => lines.push(line),
    })
    expect(record.outcome).toBe("channel-unreachable")
    expect(lines[0]).toContain("channel-unreachable")
  })
})

describe("fetchCanonicalReleaseChannel", () => {
  test("reads the latest release tag from the canonical releases endpoint", async () => {
    const url = "https://api.github.com/repos/anomalyco/opencode/releases/latest"
    let requested: string | undefined
    const tag = await fetchCanonicalReleaseChannel((async (input: RequestInfo | URL) => {
      requested = String(input)
      return Response.json({ tag_name: "v1.18.29" })
    }) as unknown as typeof fetch)
    expect(requested).toBe(url)
    expect(tag).toBe("v1.18.29")
  })

  test("a non-200 channel response throws (the caller records unreachable)", async () => {
    await expect(
      fetchCanonicalReleaseChannel((async () => new Response("x", { status: 403 })) as unknown as typeof fetch),
    ).rejects.toThrow("403")
  })

  test("a tagless channel response throws too", async () => {
    await expect(
      fetchCanonicalReleaseChannel((async () => Response.json({})) as unknown as typeof fetch),
    ).rejects.toThrow("tag_name")
  })
})
