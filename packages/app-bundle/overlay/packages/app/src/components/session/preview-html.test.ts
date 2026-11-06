import { describe, expect, test } from "bun:test"
import {
  classifyLink,
  dataUrlFromRead,
  imageMimeFor,
  isHtmlFile,
  prepareHtml,
  resolveLocalRef,
  serializeHtml,
} from "./preview-html"

// #2141: Preview renders .html pages in a scripts-off sandboxed frame. These
// helpers prepare the page (strip what would run/refresh/fetch, collect local
// images for inlining) and route link clicks.

describe("isHtmlFile", () => {
  test("matches .html and .htm, case-insensitive", () => {
    expect(isHtmlFile("status.html")).toBe(true)
    expect(isHtmlFile("a/b/Dashboard.HTM")).toBe(true)
  })
  test("does not match other files or a bare dotfile", () => {
    expect(isHtmlFile("notes.md")).toBe(false)
    expect(isHtmlFile("page.html.bak")).toBe(false)
    expect(isHtmlFile(".html")).toBe(false)
  })
})

describe("resolveLocalRef", () => {
  test("relative refs resolve against the page's folder", () => {
    expect(resolveLocalRef("plots/f1.png", "/v/sessions/s.dashboard.html")).toBe("/v/sessions/plots/f1.png")
    expect(resolveLocalRef("./f1.png", "/v/a/s.html")).toBe("/v/a/f1.png")
    expect(resolveLocalRef("../img/x.svg", "/v/a/s.html")).toBe("/v/img/x.svg")
  })
  test("a project-relative page gives a project-relative path", () => {
    expect(resolveLocalRef("f.png", "data/run/status.html")).toBe("data/run/f.png")
    expect(resolveLocalRef("f.png", "status.html")).toBe("f.png")
  })
  test("absolute paths and file:// URLs are local; percent-escapes decode", () => {
    expect(resolveLocalRef("/abs/My%20Plot.png", "/x/p.html")).toBe("/abs/My Plot.png")
    expect(resolveLocalRef("file:///Users/j/run/iter_3.png", "/x/p.html")).toBe("/Users/j/run/iter_3.png")
  })
  test("query and fragment are dropped", () => {
    expect(resolveLocalRef("f.png?v=3#top", "/x/p.html")).toBe("/x/f.png")
  })
  test("remote, data, blob, mailto, javascript, protocol-relative, empty and fragments are not local", () => {
    for (const ref of [
      "https://cdn.example/x.png",
      "http://x/y.png",
      "data:image/png;base64,AAAA",
      "blob:abc",
      "mailto:a@b",
      "javascript:alert(1)",
      "//cdn.example/x.png",
      "",
      "   ",
      "#section",
      null,
      undefined,
    ]) {
      expect(resolveLocalRef(ref as string, "/x/p.html")).toBeUndefined()
    }
  })
})

describe("classifyLink", () => {
  test("http(s) and protocol-relative links open externally", () => {
    expect(classifyLink("https://github.com/harmoniqs/Coro.jl/issues/7", "/x/p.html")).toEqual({
      kind: "external",
      url: "https://github.com/harmoniqs/Coro.jl/issues/7",
    })
    expect(classifyLink("//example.com/a", "/x/p.html")).toEqual({ kind: "external", url: "https://example.com/a" })
  })
  test("relative and file:// links open the target in Preview", () => {
    expect(classifyLink("slice_routed_v3.mp4", "/d/carried/status.html")).toEqual({
      kind: "preview",
      path: "/d/carried/slice_routed_v3.mp4",
    })
    expect(classifyLink("file:///d/log.md#x", "/x/p.html")).toEqual({ kind: "preview", path: "/d/log.md" })
  })
  test("fragments scroll within the page", () => {
    expect(classifyLink("#log", "/x/p.html")).toEqual({ kind: "anchor", id: "log" })
  })
  test("javascript:, mailto:, bare # and empty hrefs do nothing", () => {
    for (const href of ["javascript:void(0)", "mailto:a@b", "#", "", null]) {
      expect(classifyLink(href as string, "/x/p.html")).toEqual({ kind: "ignore" })
    }
  })
})

describe("prepareHtml", () => {
  const page = `<!doctype html><html><head>
    <meta charset="utf-8"><meta http-equiv="refresh" content="15">
    <base href="https://evil.example/"><link rel="stylesheet" href="style.css">
    <script src="https://cdn.plot.ly/plotly.min.js"></script><script>document.title='ran'</script>
    <style>body{color:#222}</style></head>
    <body><h1>Status</h1>
    <img src="plots/f1.png" alt="f1"><img src="https://example.com/r.png"><img src="data:image/png;base64,AA">
    <img src="javascript:alert(1)" id="bad">
    <iframe src="other.html"></iframe><object data="x.pdf"></object><embed src="x.swf">
    <video src="clip.mp4" poster="poster.png"></video>
    <picture><source srcset="big.png"><img src="small.png" srcset="small@2x.png 2x"></picture>
    <svg><image href="inner.png"></image><image href="data:image/png;base64,BB"></image></svg>
    <a href="https://github.com">gh</a></body></html>`

  test("removes everything that could run, refresh, re-base or embed", () => {
    const html = serializeHtml(prepareHtml(page, "/v/s/status.html").doc)
    expect(html).not.toContain("<script")
    expect(html).not.toContain("refresh")
    expect(html).not.toContain("<base")
    expect(html).not.toContain("<link")
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain("<object")
    expect(html).not.toContain("<embed")
    expect(html).not.toContain("<source")
  })

  test("keeps the page's content and inline styles", () => {
    const html = serializeHtml(prepareHtml(page, "/v/s/status.html").doc)
    expect(html).toContain("<h1>Status</h1>")
    expect(html).toContain("body{color:#222}")
    expect(html).toContain('href="https://github.com"')
    expect(html.startsWith("<!doctype html>")).toBe(true)
  })

  test("collects local images (img src, SVG image href) for inlining, in document order", () => {
    const { images } = prepareHtml(page, "/v/s/status.html")
    expect(images.map((i) => [i.attribute, i.path])).toEqual([
      ["src", "/v/s/plots/f1.png"],
      ["src", "/v/s/small.png"],
      ["href", "/v/s/inner.png"],
    ])
  })

  test("keeps https and data image sources, drops other fetching attributes", () => {
    const { doc } = prepareHtml(page, "/v/s/status.html")
    const srcs = Array.from(doc.querySelectorAll("img")).map((i) => i.getAttribute("src"))
    expect(srcs).toContain("https://example.com/r.png")
    expect(srcs).toContain("data:image/png;base64,AA")
    expect(doc.getElementById("bad")!.hasAttribute("src")).toBe(false)
    const video = doc.querySelector("video")!
    expect(video.hasAttribute("src")).toBe(false)
    expect(video.hasAttribute("poster")).toBe(false)
    expect(doc.querySelector("img[srcset]")).toBeNull()
  })
})

describe("dataUrlFromRead", () => {
  test("base64 image reads become data URIs, preferring the server's mime", () => {
    expect(dataUrlFromRead({ type: "binary", encoding: "base64", content: "AAA", mimeType: "image/png" }, "a.png")).toBe(
      "data:image/png;base64,AAA",
    )
    expect(dataUrlFromRead({ type: "binary", encoding: "base64", content: "AAA" }, "a.JPG")).toBe(
      "data:image/jpeg;base64,AAA",
    )
  })
  test("an SVG read as text becomes a URL-encoded SVG data URI", () => {
    expect(dataUrlFromRead({ type: "text", content: "<svg/>" }, "p.svg")).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    )
  })
  test("unusable reads give undefined", () => {
    expect(dataUrlFromRead(null, "a.png")).toBeUndefined()
    expect(dataUrlFromRead({ type: "text", content: "hello" }, "a.txt")).toBeUndefined()
    expect(dataUrlFromRead({ type: "binary", encoding: "base64", content: "" }, "a.png")).toBeUndefined()
    expect(dataUrlFromRead({ type: "binary", encoding: "base64", content: "AA", mimeType: "video/mp4" }, "a.mp4")).toBeUndefined()
  })
  test("mime guessing covers the plot formats", () => {
    expect(imageMimeFor("x.svg")).toBe("image/svg+xml")
    expect(imageMimeFor("x.webp")).toBe("image/webp")
    expect(imageMimeFor("x.mp4")).toBeUndefined()
  })
})
