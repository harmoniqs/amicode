import { describe, expect, test } from "bun:test"
import { parseTruncatedModuleUrl, retryImport } from "./retry-import"

// #1459: the tunnel-truncation class. The module map caches a failed dynamic
// import for the document's life; the retry re-imports the parsed failing URL
// cache-busted (a fresh module-map key). The unit suite pins the CONTRACT:
// only the specific truncation error retries, the bust derives from the
// failing URL with any previous query stripped, the backoff chain rides out
// minutes-long transport windows, and real errors (404, syntax) rethrow
// untouched. The importer is injected so the engine's `import()` never runs
// in the suite.

const truncationError = (url: string) =>
  new TypeError(`Failed to fetch dynamically imported module: ${url}`)

describe("parseTruncatedModuleUrl", () => {
  test("extracts the URL from the truncation error", () => {
    expect(parseTruncatedModuleUrl(truncationError("http://127.0.0.1:4097/assets/new-session-abc.js"))).toBe(
      "http://127.0.0.1:4097/assets/new-session-abc.js",
    )
  })

  test("non-truncation errors are not retry candidates", () => {
    expect(parseTruncatedModuleUrl(new SyntaxError("Unexpected token '<'"))).toBeNull()
    expect(parseTruncatedModuleUrl(new TypeError("NetworkError when attempting to fetch resource"))).toBeNull()
    expect(parseTruncatedModuleUrl(undefined)).toBeNull()
  })
})

describe("retryImport", () => {
  test("success passes through untouched", async () => {
    const result = await retryImport(() => Promise.resolve(42 as const))
    expect(result).toBe(42)
  })

  test("non-truncation errors rethrow immediately", async () => {
    const boom = new SyntaxError("Unexpected token '<'")
    const importer = () => Promise.reject(boom)
    await expect(retryImport(() => Promise.reject(boom), { importer })).rejects.toBe(boom)
  })

  test("a truncation failure re-imports the parsed URL cache-busted", async () => {
    const bustedUrls: string[] = []
    const importer = (url: string) => {
      bustedUrls.push(url)
      return Promise.resolve("recovered" as const)
    }
    const result = await retryImport(
      () => Promise.reject(truncationError("http://127.0.0.1:4097/assets/new-session-abc.js")),
      { importer, delays: [1] },
    )
    expect(result).toBe("recovered")
    expect(bustedUrls).toHaveLength(1)
    expect(bustedUrls[0].startsWith("http://127.0.0.1:4097/assets/new-session-abc.js?retry=")).toBe(true)
  })

  test("chained truncations retry with the previous query stripped", async () => {
    const seen: string[] = []
    let engineFailures = 0
    const importer = (url: string) => {
      seen.push(url)
      if (engineFailures++ < 2) {
        // The engine reports the BUSTED URL as the new failure point — the
        // next attempt must strip that query and re-bust.
        return Promise.reject(truncationError(url))
      }
      return Promise.resolve("recovered" as const)
    }
    const result = await retryImport(
      () => Promise.reject(truncationError("http://127.0.0.1:4097/assets/new-session-abc.js")),
      { importer, delays: [1, 1, 1] },
    )
    expect(result).toBe("recovered")
    expect(seen).toHaveLength(3)
    for (const url of seen) {
      expect(url.startsWith("http://127.0.0.1:4097/assets/new-session-abc.js?retry=")).toBe(true)
      expect((url.match(/retry=/g) ?? []).length).toBe(1) // never a doubled query
    }
  })

  test("the backoff chain exhausts and rethrows the last truncation", async () => {
    const importer = (url: string) => Promise.reject(truncationError(url))
    const first = truncationError("http://127.0.0.1:4097/assets/new-session-abc.js")
    await expect(
      retryImport(() => Promise.reject(first), { importer, attempts: 3, delays: [1, 1, 1] }),
    ).rejects.toThrow("Failed to fetch dynamically imported module")
  })
})
