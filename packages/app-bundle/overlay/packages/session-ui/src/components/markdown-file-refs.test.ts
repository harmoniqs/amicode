import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  cachedFileRef,
  clearFileRefCache,
  fileRefResolver,
  fileRefResolverVersion,
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

// #1839 — file-reference linkification is a core capability, not a layout
// preference. Reported live 2026-10-22: with data-new-layout off, every file
// path in chat rendered as an inert pill — markInlineCode (the path-kind
// tagging) and markFileLinks (the anchor wrapping) were both gated on the
// new-layout body attribute, silently, with zero errors. The wiring must be
// unconditional, like markExternalLinks (issue #270's precedent). Asserted on
// the component source per the repo's component-source-assertion convention.
describe("file-ref wiring is not layout-gated (#1839)", () => {
  const source = readFileSync(resolve(__dirname, "markdown.tsx"), "utf8")

  test("decorate tags inline-code pills unconditionally — no new-layout early return", () => {
    const start = source.indexOf("function decorate(")
    const body = source.slice(start, source.indexOf("function markExternalLinks("))
    expect(start).toBeGreaterThan(0)
    expect(body).toContain("markInlineCode(root)")
    expect(body).not.toContain("data-new-layout")
  })

  test("markFileLinks runs unconditionally in the render effect", () => {
    expect(source).toContain("markFileLinks(container)")
    expect(source).not.toContain('data-new-layout")) markFileLinks')
  })
})

// #1845: shells remount on the /<dir>/session → /server/…/session redirect;
// the outgoing shell's cleanup ran after the incoming shell registered and
// wiped the live resolver, so chat file links never linkified.
describe("registration handles (#1845)", () => {
  test("a stale unregister does not clear the newer registration", () => {
    const a = async () => "/a"
    const b = async () => "/b"
    const unregisterA = registerFileRefResolver(a)
    registerFileRefResolver(b)
    unregisterA()
    expect(fileRefResolver()).toBe(b)
  })

  test("the current registration's unregister clears it and bumps the version", () => {
    const before = fileRefResolverVersion()
    const unregister = registerFileRefResolver(async () => "/x")
    expect(fileRefResolverVersion()).toBe(before + 1)
    unregister()
    expect(fileRefResolver()).toBeUndefined()
    expect(fileRefResolverVersion()).toBe(before + 2)
  })
})
