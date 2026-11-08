import { describe, expect, test } from "bun:test"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const server = "http://127.0.0.1:4096" as ServerConnection.Key

describe("tab migration — pinned tabs (amicode#2154)", () => {
  test("keeps the pinned flag on session tabs", () => {
    expect(migrateTabs([{ type: "session", server, sessionId: "a", pinned: true }], server)).toEqual([
      { type: "session", server, sessionId: "a", pinned: true },
    ])
  })

  test("drops a non-true pinned value instead of storing it", () => {
    expect(
      migrateTabs(
        [
          { type: "session", server, sessionId: "a", pinned: false },
          { type: "session", server, sessionId: "b", pinned: "yes" },
        ],
        server,
      ),
    ).toEqual([
      { type: "session", server, sessionId: "a" },
      { type: "session", server, sessionId: "b" },
    ])
  })

  test("never pins a draft", () => {
    expect(
      migrateTabs([{ type: "draft", server, draftID: "d", directory: "/repo", pinned: true }], server),
    ).toEqual([{ type: "draft", server, draftID: "d", directory: "/repo", worktree: undefined }])
  })
})
