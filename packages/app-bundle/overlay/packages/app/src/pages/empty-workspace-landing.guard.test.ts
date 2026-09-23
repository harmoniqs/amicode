import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #1458: the empty-workspace landing renders at the "/" route, which never
// sits inside a SyncProvider. Its titlebar portals once mounted
// SessionChatsDropdown/StatusPopoverV2 (per-directory sync-context readers)
// there — at real-boot timing the no-directory window renders this landing
// briefly on EVERY boot, and the useSync() throw killed the whole route tree
// including the landing effect (no draft ever created; the app frozen at
// "/"). This guard pins the regression at the seam where it lives: the
// landing module must not depend on directory-scoped context components.
// (The unit-suite trap this guards against: rendering with mocked contexts
// passes while the real boot crashes — caught live by the e2e rig.)

describe("EmptyWorkspaceLanding context-freedom (#1458)", () => {
  const source = readFileSync(
    join(import.meta.dirname, "empty-workspace-landing.tsx"),
    "utf8",
  )

  test("no sync-context components in the landing module", () => {
    expect(source).not.toContain("SessionChatsDropdown")
    expect(source).not.toContain("StatusPopover")
    expect(source).not.toContain("session-header")
    expect(source).not.toContain("status-popover")
  })

  test("the landing still owns its content: the open-folder prompt", () => {
    expect(source).toContain("requestAddWorkspaceProject")
  })
})
