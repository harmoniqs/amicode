import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ServerScope } from "@/utils/server-scope"
import { Worktree } from "@/utils/worktree"
import { handleWorktreeLifecycleEvent, isViewingSessionOrAncestor } from "./notification-toasts"

const directory = (name: string) => `/tmp/opencode-worktree-lifecycle-${name}-${crypto.randomUUID()}`
const legacyLayout = readFileSync(join(import.meta.dir, "..", "layout.tsx"), "utf8")
const newLayout = readFileSync(join(import.meta.dir, "..", "layout-new.tsx"), "utf8")
const notificationToasts = readFileSync(join(import.meta.dir, "notification-toasts.ts"), "utf8")

describe("worktree lifecycle notifications", () => {
  test("releases a pending worktree when the server reports readiness", async () => {
    const scope = ServerScope.local
    const worktree = directory("ready")
    const busy: Array<{ directory: string; value: boolean }> = []

    Worktree.pending(scope, worktree)
    const waiting = Worktree.wait(scope, worktree)
    expect(
      handleWorktreeLifecycleEvent(
        {
          name: worktree,
          details: { type: "worktree.ready" },
        },
        {
          scope,
          setBusy: (directory, value) => busy.push({ directory, value }),
          fallbackMessage: "request failed",
        },
      ),
    ).toBe(true)

    expect(await waiting).toEqual({ status: "ready" })
    expect(busy).toEqual([{ directory: worktree, value: false }])
  })

  test("releases a pending worktree with the server failure message", async () => {
    const scope = ServerScope.local
    const worktree = directory("failed")
    Worktree.pending(scope, worktree)
    const waiting = Worktree.wait(scope, worktree)

    expect(
      handleWorktreeLifecycleEvent(
        {
          name: worktree,
          details: {
            type: "worktree.failed",
            properties: { message: "bootstrap failed" },
          },
        },
        {
          scope,
          fallbackMessage: "request failed",
        },
      ),
    ).toBe(true)

    expect(await Promise.race([waiting, Bun.sleep(20).then(() => ({ status: "still waiting" as const }))])).toEqual({
      status: "failed",
      message: "bootstrap failed",
    })
  })

  test("ignores events outside the worktree lifecycle", () => {
    const scope = ServerScope.local
    const worktree = directory("unrelated")
    const busy: Array<{ directory: string; value: boolean }> = []
    Worktree.pending(scope, worktree)

    expect(
      handleWorktreeLifecycleEvent(
        {
          name: worktree,
          details: { type: "session.updated" },
        },
        {
          scope,
          setBusy: (directory, value) => busy.push({ directory, value }),
          fallbackMessage: "request failed",
        },
      ),
    ).toBe(false)

    expect(Worktree.get(scope, worktree)).toEqual({ status: "pending" })
    expect(busy).toEqual([])
  })

  test("mounts the shared lifecycle hook from both layout roots", () => {
    expect(legacyLayout).toContain('import { useNotificationToasts } from "./layout/notification-toasts"')
    expect(legacyLayout).toContain("useNotificationToasts({ setBusy })")
    expect(newLayout).toContain('import { useNotificationToasts } from "./layout/notification-toasts"')
    expect(newLayout).toContain("useNotificationToasts()")
    expect(notificationToasts).toContain("serverSDK().event.listen")
    expect(notificationToasts).toContain("handleWorktreeLifecycleEvent(event")
  })
})

describe("#1948 — no toast for a session you are already viewing", () => {
  const parents = (links: Record<string, string>) => (id: string) => links[id]

  test("a question in the viewed session is suppressed", () => {
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_a", sessionID: "ses_a", parentOf: parents({}) })).toBe(true)
  })

  test("a question from a subagent (child or grandchild) of the viewed session is suppressed", () => {
    const parentOf = parents({ ses_child: "ses_a", ses_grandchild: "ses_child" })
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_a", sessionID: "ses_child", parentOf })).toBe(true)
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_a", sessionID: "ses_grandchild", parentOf })).toBe(true)
  })

  test("a question from an unrelated session still toasts", () => {
    const parentOf = parents({ ses_child: "ses_a" })
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_a", sessionID: "ses_other", parentOf })).toBe(false)
    // the viewed session's own parent asking is NOT suppressed (ancestry runs upward from the asker only)
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_child", sessionID: "ses_a", parentOf })).toBe(false)
  })

  test("no viewed session (home / new-session route) never suppresses", () => {
    expect(isViewingSessionOrAncestor({ viewedSessionID: undefined, sessionID: "ses_a", parentOf: parents({}) })).toBe(false)
  })

  test("a parent-link cycle never hangs the walk", () => {
    const parentOf = parents({ ses_x: "ses_y", ses_y: "ses_x" })
    expect(isViewingSessionOrAncestor({ viewedSessionID: "ses_a", sessionID: "ses_x", parentOf })).toBe(false)
  })

  test("the hook suppresses on session identity alone — the directory strings may differ (hub route vs event dir)", () => {
    // Session ids are globally unique: the suppression must not gate on
    // pathKey(directory) === pathKey(currentDir()).
    expect(notificationToasts).not.toContain("pathKey(directory) === pathKey(currentDir())")
    expect(notificationToasts).toContain("isViewingSessionOrAncestor({")
    expect(notificationToasts).toContain("viewedSessionID: params.id")
    // parentID is learned from the stream's session.created/updated so a child
    // absent from the (bootstrap: false) store still resolves its ancestry.
    expect(notificationToasts).toContain('"session.created"')
    // platform.notify keeps its own focus guard and still runs before the toast check.
    expect(notificationToasts.indexOf("platform.notify(")).toBeLessThan(notificationToasts.indexOf("isViewingSessionOrAncestor({"))
  })
})
