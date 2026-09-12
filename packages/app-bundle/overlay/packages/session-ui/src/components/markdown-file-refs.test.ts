import { beforeEach, describe, expect, test } from "bun:test"
import {
  cachedFileRef,
  clearFileRefCache,
  fileRefResolver,
  fileRefUrl,
  registerFileRefResolver,
  resolveFileRefCached,
} from "./markdown-file-refs"

beforeEach(() => {
  registerFileRefResolver(undefined)
  clearFileRefCache()
})

describe("resolver registry", () => {
  test("no resolver registered → resolves to null, uncached", async () => {
    expect(fileRefResolver()).toBeUndefined()
    expect(await resolveFileRefCached("foo.md")).toBeNull()
    expect(cachedFileRef("foo.md")).toBeUndefined()
  })

  test("resolution results are cached, hits and misses alike", async () => {
    let calls = 0
    registerFileRefResolver(async (text) => {
      calls++
      return text.startsWith("real") ? `/abs/${text}` : null
    })
    expect(await resolveFileRefCached("real.md")).toBe("/abs/real.md")
    expect(await resolveFileRefCached("ghost.md")).toBeNull()
    expect(await resolveFileRefCached("real.md")).toBe("/abs/real.md")
    expect(cachedFileRef("real.md")).toBe("/abs/real.md")
    expect(cachedFileRef("ghost.md")).toBeNull()
    expect(calls).toBe(2) // second real.md call came from cache
  })

  test("in-flight resolutions dedupe", async () => {
    let calls = 0
    registerFileRefResolver(async (text) => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return `/abs/${text}`
    })
    const [a, b] = await Promise.all([resolveFileRefCached("x.md"), resolveFileRefCached("x.md")])
    expect(a).toBe("/abs/x.md")
    expect(b).toBe("/abs/x.md")
    expect(calls).toBe(1)
  })

  test("resolver failures stay UNCACHED so the next render retries", async () => {
    let calls = 0
    registerFileRefResolver(async () => {
      calls++
      if (calls === 1) throw new Error("server down")
      return "/abs/recovered.md"
    })
    expect(await resolveFileRefCached("recovered.md")).toBeNull()
    expect(cachedFileRef("recovered.md")).toBeUndefined()
    expect(await resolveFileRefCached("recovered.md")).toBe("/abs/recovered.md")
    expect(calls).toBe(2)
  })
})

describe("fileRefUrl", () => {
  test("posix absolute paths encode spaces, keep slashes", () => {
    expect(fileRefUrl("/Users/aaron/My Notes/insight-1.md")).toBe("file:///Users/aaron/My%20Notes/insight-1.md")
  })
})
