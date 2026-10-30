import { beforeEach, describe, expect, test } from "bun:test"
import {
  cachedLocalImage,
  clearLocalImageCache,
  loadLocalImageCached,
  localImageLoaderVersion,
  localImagePath,
  frameImages,
  imageFileName,
  loadLocalImages,
  registerLocalImageLoader,
} from "./markdown-local-images"

const host = (action?: string) => {
  const el = document.createElement("div")
  el.setAttribute("data-slot", "markdown-copy-button")
  if (action) el.setAttribute("data-action", action)
  return el
}
const button = () => [host("download"), host()]
const PNG = "data:image/png;base64,iVBORw0KGgo="

beforeEach(() => {
  registerLocalImageLoader(undefined)
  clearLocalImageCache()
})

function block(html: string) {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("localImagePath", () => {
  test("absolute posix image paths are local; query and hash are dropped", () => {
    expect(localImagePath("/home/me/talk/eq 1.png")).toBe("/home/me/talk/eq 1.png")
    expect(localImagePath("/home/me/talk/eq%201.png?v=2#x")).toBe("/home/me/talk/eq 1.png")
    expect(localImagePath("file:///tmp/plot.svg")).toBe("/tmp/plot.svg")
  })

  test("remote, data, protocol-relative, relative and non-image sources are not", () => {
    expect(localImagePath("https://example.com/a.png")).toBeUndefined()
    expect(localImagePath(PNG)).toBeUndefined()
    expect(localImagePath("//cdn.example.com/a.png")).toBeUndefined()
    expect(localImagePath("plots/a.png")).toBeUndefined()
    expect(localImagePath("/home/me/notes.md")).toBeUndefined()
  })
})

describe("loader registry", () => {
  test("no loader → null, nothing cached", async () => {
    expect(await loadLocalImageCached("/a.png")).toBeNull()
    expect(cachedLocalImage("/a.png")).toBeUndefined()
  })

  test("loads cache hits and dedupe in flight; misses stay uncached for retry", async () => {
    let calls = 0
    registerLocalImageLoader(async (path) => {
      calls++
      return path === "/real.png" ? PNG : null
    })
    const [a, b] = await Promise.all([loadLocalImageCached("/real.png"), loadLocalImageCached("/real.png")])
    expect(a).toBe(PNG)
    expect(b).toBe(PNG)
    expect(await loadLocalImageCached("/real.png")).toBe(PNG)
    expect(calls).toBe(1)
    expect(await loadLocalImageCached("/missing.png")).toBeNull()
    expect(cachedLocalImage("/missing.png")).toBeUndefined()
  })

  test("a stale unregister keeps the newer loader; registration bumps the version", async () => {
    const before = localImageLoaderVersion()
    const stale = registerLocalImageLoader(async () => null)
    registerLocalImageLoader(async () => PNG)
    stale()
    expect(localImageLoaderVersion()).toBeGreaterThan(before)
    expect(await loadLocalImageCached("/x.png")).toBe(PNG)
  })
})

describe("chat image frames", () => {
  test("every image is framed with download + copy buttons, once", () => {
    const root = block('<p><img src="https://example.com/a.png" alt="a"></p>')
    frameImages(root, button)
    frameImages(root, button)
    const frames = root.querySelectorAll('[data-component="markdown-image"]')
    expect(frames.length).toBe(1)
    expect(frames[0]!.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png")
    expect(frames[0]!.querySelectorAll('[data-slot="markdown-copy-button"]').length).toBe(2)
    expect(frames[0]!.querySelectorAll('[data-action="download"]').length).toBe(1)
  })

  test("a local path never reaches the network: src is parked until the loader answers", async () => {
    let release: (url: string) => void = () => {}
    registerLocalImageLoader(() => new Promise<string>((resolve) => (release = resolve)))
    const root = block('<p><img src="/home/me/eq.png" alt="eq"></p>')
    frameImages(root, button)
    const img = root.querySelector("img")!
    expect(img.hasAttribute("src")).toBe(false)
    expect(img.getAttribute("data-local-src")).toBe("/home/me/eq.png")
    loadLocalImages(root)
    release(PNG)
    await tick()
    expect(img.getAttribute("src")).toBe(PNG)
  })

  test("once cached, re-decorating sets the data URL synchronously (no flash on rebuild)", async () => {
    registerLocalImageLoader(async () => PNG)
    await loadLocalImageCached("/home/me/eq.png")
    const root = block('<p><img src="/home/me/eq.png"></p>')
    frameImages(root, button)
    expect(root.querySelector("img")?.getAttribute("src")).toBe(PNG)
  })
})

describe("imageFileName", () => {
  const img = (html: string) => {
    const root = block(html)
    frameImages(root, button)
    return root.querySelector("img")!
  }

  test("a disk image keeps its basename, saved as png", () => {
    expect(imageFileName(img('<img src="/home/me/talk/18-piccolo-mintime.png" alt="eq">'))).toBe(
      "18-piccolo-mintime.png",
    )
    expect(imageFileName(img('<img src="/tmp/plot.svg">'))).toBe("plot.png")
    expect(imageFileName(img('<img src="/home/me/my%20figure.v2.jpg">'))).toBe("my-figure.v2.png")
  })

  test("otherwise the alt text names it, else 'image'", () => {
    expect(imageFileName(img('<img src="https://example.com/a" alt="Fig 3: comb vs posterior">'))).toBe(
      "Fig-3-comb-vs-posterior.png",
    )
    expect(imageFileName(img('<img src="https://example.com/a">'))).toBe("image.png")
    expect(imageFileName(img('<img src="https://example.com/a" alt="../../">'))).toBe("image.png")
  })
})
