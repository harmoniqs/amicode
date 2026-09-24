import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { State } from "./global-sync/types"
import { createDirSyncContext } from "./directory-sync"

describe("directory diff-version delegation", () => {
  test("reads and writes the shared ServerSession diff version without creating a directory copy", () => {
    const [directory, setDirectory] = createStore({ session: [] } as unknown as State)
    const [serverSession, setServerSession] = createStore({ diff_version: { tab: 0 } })
    let dispose: (() => void) | undefined
    let sync: ReturnType<typeof createDirSyncContext> | undefined

    createRoot((cleanup) => {
      dispose = cleanup
      sync = createDirSyncContext(
        "/project",
        {
          child: () => [directory, setDirectory],
          session: { data: serverSession, set: setServerSession },
        } as never,
        { createClient: () => ({}) } as never,
      )
    })

    expect(sync?.data.diff_version).toBe(serverSession.diff_version)
    ;(sync?.set as unknown as (...args: unknown[]) => void)("diff_version", "tab", (version: number | undefined) =>
      (version ?? 0) + 1,
    )

    expect(serverSession.diff_version.tab).toBe(1)
    expect((directory as { diff_version?: unknown }).diff_version).toBeUndefined()
    dispose?.()
  })
})
