import { sandbox } from "./env"

export interface Target {
  /** Serve this directly (web-standard handler), or... */
  handler?: (request: Request) => Promise<Response> | Response
  /** ...it is already listening natively here. */
  nativeUrl?: string
  /** Does the seam itself enforce a password on standard routes? */
  nativeAuth: boolean
  /** Is a custom route already present in the bare seam (before any host front)? */
  customRouteInBare: boolean
  /** In-process plugin registration. undefined = the seam exposes no handle. */
  registerPlugin?: () => Promise<void>
  /** Id of a file-config plugin the seam is expected to have loaded (stock route only). */
  filePluginId?: string
  /** Drive a workspace provider end to end. undefined = not reachable through this seam. */
  workspaceProbe?: () => Promise<string>
  /** Free-form facts observed while building the target. */
  facts: Record<string, unknown>
  stop: () => Promise<void>
}

export const serverOptions = (password?: string) => ({
  ...(password ? { password } : {}),
  app: { name: "h0c", version: "0.0.0-h0c" },
  database: { path: sandbox.dbPath },
  config: { directory: sandbox.configDir, project: false, claude: false, content: "{}" },
  models: { fetch: false },
  fs: { filewatcher: false, fff: false },
})

/** A trivial workspace driver: records calls, never touches anything remote. */
export function makeProbeDriver(calls: string[]) {
  return async () => {
    const { WorkspaceDriver } = await import("@opencode/core/workspace/driver")
    const { makeMemoryDriver } = await import("@opencode/core/environment/index")
    const { Effect } = await import("effect")
    return WorkspaceDriver.make({
      create: ({ workspaceID }) => {
        calls.push("create")
        return Effect.succeed({ binding: { externalID: workspaceID } })
      },
      connect: () => {
        calls.push("connect")
        return Effect.succeed(makeMemoryDriver())
      },
      suspendForIdle: () => Effect.void,
      destroy: () => {
        calls.push("destroy")
        return Effect.void
      },
    })
  }
}
