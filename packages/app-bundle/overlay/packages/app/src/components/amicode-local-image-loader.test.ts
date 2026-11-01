import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { loadLocalImageViaServer } from "./amicode-local-image-loader"

const conn = { http: { url: "http://127.0.0.1:43117" } } as unknown as ServerConnection.Any

describe("loadLocalImageViaServer (chat local-image loader)", () => {
  test("no selected server resolves null — never throws, never fetches", async () => {
    let called = false
    const get = async () => {
      called = true
      return {}
    }
    expect(await loadLocalImageViaServer(undefined, "/tmp/eq.png", get)).toBeNull()
    expect(called).toBe(false)
  })

  test("the default getter with no server still resolves null (amicodeGet would throw)", async () => {
    expect(await loadLocalImageViaServer(undefined, "/tmp/eq.png")).toBeNull()
  })

  test("a failing fetch resolves null", async () => {
    const get = async () => {
      throw new Error("HTTP 500")
    }
    expect(await loadLocalImageViaServer(conn, "/tmp/eq.png", get)).toBeNull()
  })

  test("binary image content becomes a data URL; SVG text is encoded; other content is null", async () => {
    const routes: string[] = []
    const png = async (_c: ServerConnection.Any, route: string) => {
      routes.push(route)
      return { type: "binary", encoding: "base64", mimeType: "image/png", content: "iVBORw0KGgo=" }
    }
    expect(await loadLocalImageViaServer(conn, "/tmp/a b.png", png)).toBe("data:image/png;base64,iVBORw0KGgo=")
    expect(routes[0]).toBe("/file/content?path=%2Ftmp%2Fa%20b.png")
    const svg = async () => ({ type: "text", content: "<svg/>" })
    expect(await loadLocalImageViaServer(conn, "/tmp/eq.svg", svg)).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")
    const text = async () => ({ type: "text", content: "hello" })
    expect(await loadLocalImageViaServer(conn, "/tmp/eq.png", text)).toBeNull()
  })
})
