// Issue #817 — H1, the fresh-client boot harness (#288's headless boot),
// ported from the fork reference with the client-derived currency: boots the
// client's session-list layer against a seeded hub and asserts on the hub's
// request log — the same evidence that diagnosed #293.
import { describe, expect, test } from "vitest"
import { bootClient, createSeededHub, memorySessionStorage } from "../../app-bundle/overlay/packages/app/src/context/global-sync/h1-client-boot"

const session = (id: string, updated: number) => ({
  id,
  directory: "/home",
  projectID: "p1",
  slug: id,
  version: "test",
  title: `Session ${id}`,
  time: { created: updated, updated },
})

const hubSessions = () => [session("ses_a", 100), session("ses_b", 200)]
const SERVER_VERSION = "v1.18.29"

describe("H1 — the fresh-client boot harness (#288's headless boot, hub request log)", () => {
  test("a fresh client boots with the session-list fetch initiated before the list first renders", async () => {
    const hub = createSeededHub({ sessions: hubSessions(), version: SERVER_VERSION })
    const storage = memorySessionStorage()

    const boot = await bootClient({ hub, storage, directory: "/home" })

    // The criterion is measured on the hub's request log, the same evidence
    // that diagnosed #293: at least one session-list request in the boot
    // window.
    expect(boot.sessionListRequests.length).toBeGreaterThanOrEqual(1)
    expect(boot.fetchedBeforeFirstRender).toBe(true)
    // The fetched rows are adopted and the state is honest: a resolved fetch
    // over a populated projection renders ready.
    expect(boot.rendered.map((item) => item.id)).toEqual(["ses_b", "ses_a"])
    expect(boot.state).toBe("ready")
    // The snapshot layer now holds the fetched rows plus the client-derived
    // token (count 2, max 200, sum 300, hub build stamp).
    const persisted = storage.read("/home")
    expect(persisted?.currency).toBe("v1.2.200.300.v1.18.29")
    expect(persisted?.sessions).toHaveLength(2)
  })

  test("a client seeded with the #293 stale-storage shape self-heals on boot", async () => {
    const hub = createSeededHub({ sessions: hubSessions(), version: SERVER_VERSION })
    const storage = memorySessionStorage({
      "/home": { sessions: [session("ses_stale", 1)], currency: "v1.1.1.1.v1.18.10-amicode.21" },
    })

    const boot = await bootClient({ hub, storage, directory: "/home" })

    expect(boot.selfHealed).toBe(true)
    // The stale snapshot never wins: the rendered list is the hub's.
    expect(boot.rendered.map((item) => item.id)).toEqual(["ses_b", "ses_a"])
    expect(boot.state).toBe("ready")
    // The persisted snapshot was re-primed from the server's truth.
    expect(storage.read("/home")?.currency).toBe("v1.2.200.300.v1.18.29")
  })

  test("a tokenless persisted snapshot (the founding shape) is invalidated too", async () => {
    const hub = createSeededHub({ sessions: [], version: SERVER_VERSION })
    const storage = memorySessionStorage({ "/home": { sessions: [session("ses_stale", 1)] } })

    const boot = await bootClient({ hub, storage, directory: "/home" })

    expect(boot.selfHealed).toBe(true)
    expect(boot.rendered).toHaveLength(0)
    // Honest states: a resolved fetch over an empty projection is genuinely
    // empty — never "not yet fetched".
    expect(boot.state).toBe("empty")
  })

  test("a fresh snapshot is not flagged as self-healed", async () => {
    const rows = hubSessions()
    const hub = createSeededHub({ sessions: rows, version: SERVER_VERSION })
    const storage = memorySessionStorage({
      "/home": { sessions: [...rows], currency: "v1.2.200.300.v1.18.29" },
    })

    const boot = await bootClient({ hub, storage, directory: "/home" })

    expect(boot.selfHealed).toBe(false)
    expect(boot.rendered).toHaveLength(2)
  })

  test("a projection that changed out-of-band between boots flips the token and self-heals", async () => {
    const hub = createSeededHub({ sessions: [session("ses_a", 100)], version: SERVER_VERSION })
    const storage = memorySessionStorage({
      "/home": { sessions: hubSessions(), currency: "v1.2.200.300.v1.18.29" },
    })

    const boot = await bootClient({ hub, storage, directory: "/home" })

    expect(boot.selfHealed).toBe(true)
    expect(boot.rendered).toHaveLength(1)
    expect(storage.read("/home")?.currency).toBe("v1.1.100.100.v1.18.29")
  })
})
