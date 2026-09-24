import { describe, expect, test } from "bun:test"
import { retryImport } from "./retry-import"

const truncationError = (url: string) => new TypeError(`Failed to fetch dynamically imported module: ${url}`)

describe("retryImport", () => {
  test("retries a truncation URL while preserving its query parameters", async () => {
    const imported: string[] = []

    const result = await retryImport(
      () =>
        Promise.reject(
          truncationError("http://127.0.0.1:4097/assets/new-session.js?workspace=demo&retry=stale&locale=en"),
        ),
      {
        delays: [0],
        sleep: async () => {},
        now: () => 123,
        importer: async (url) => {
          imported.push(url)
          return "recovered" as const
        },
      },
    )

    expect(result).toBe("recovered")
    expect(imported).toEqual(["http://127.0.0.1:4097/assets/new-session.js?workspace=demo&retry=123&locale=en"])
  })

  test("bounds retry waiting to the 31-second backoff budget", async () => {
    const waited: number[] = []
    let lastError: TypeError | undefined

    let caught: unknown
    try {
      await retryImport(() => Promise.reject(truncationError("http://127.0.0.1:4097/assets/new-session.js")), {
        sleep: async (delay) => {
          waited.push(delay)
        },
        importer: async (url) => {
          lastError = truncationError(url)
          throw lastError
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(lastError)
    expect(waited).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(waited.reduce((total, delay) => total + delay, 0)).toBe(31_000)
  })

  test("leaves non-transient errors untouched", async () => {
    const original = new SyntaxError("Unexpected token '<'")
    let importerCalls = 0
    let sleepCalls = 0
    let caught: unknown

    try {
      await retryImport(() => Promise.reject(original), {
        importer: async () => {
          importerCalls++
          return "unreachable"
        },
        sleep: async () => {
          sleepCalls++
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(importerCalls).toBe(0)
    expect(sleepCalls).toBe(0)
  })
})
