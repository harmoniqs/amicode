import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { useSettings } from "@/context/settings"
import { inAmicode } from "@/utils/amicode-bridge"
import { applyRebuildFlagMutation, rebuildFlagMutation } from "./developer-tools-rebuild-flags"
import { reduceDevToolsRequest } from "./developer-tools-request-state"

export interface DevToolsStatus {
  opencodeValid: boolean
  opencodeError?: string
  amicodeValid: boolean
  amicodeError?: string
  serverRestarted: boolean
  reloadNeeded: boolean
}

export type RebuildState = "idle" | "rebuilding" | "rebuilt" | "failed"

/** Structured rebuild error from the catalog (rebuild_errors.ts). */
export interface RebuildErrorInfo {
  /** One-line error message. */
  message: string
  /** Numbered fix steps. */
  fix: string[]
  /** Raw stderr / stack trace (collapsible). */
  detail?: string
}

/** Default repo paths autofilled when the toggle is turned ON with empty fields. */
const DEFAULT_OPENCODE_PATH = "~/harmoniqs/opencode"
const DEFAULT_AMICODE_PATH = "~/harmoniqs/amicode"

export function createDeveloperToolsController() {
  const settings = useSettings()
  const [status, setStatus] = createSignal<DevToolsStatus | undefined>(undefined)
  const [pending, setPending] = createSignal(false)
  const [rebuildState, setRebuildState] = createSignal<RebuildState>("idle")
  const [rebuildError, setRebuildError] = createSignal<RebuildErrorInfo | undefined>(undefined)
  const [vsixBuildState, setVsixBuildState] = createSignal<RebuildState>("idle")
  const [vsixBuildError, setVsixBuildError] = createSignal<string | undefined>(undefined)
  const [vsixPath, setVsixPath] = createSignal<string | undefined>(undefined)

  // On mount, check if we just came back from a rebuild (successful or in-progress).
  // The "rebuilding" flag survives iframe reloads caused by file-watcher churn
  // (e.g. git checkout in a watched workspace folder during remote rebuild).
  onMount(() => {
    try {
      const wasRebuilding = localStorage.getItem("amicode:devtools-rebuilding") === "1"
      const didFinish = localStorage.getItem("amicode:devtools-rebuilt") === "1"

      if (wasRebuilding && didFinish) {
        // Rebuild completed during a reload — show success (persists until dialog closes)
        localStorage.removeItem("amicode:devtools-rebuilding")
        localStorage.removeItem("amicode:devtools-rebuilt")
        setRebuildState("rebuilt")
      } else if (wasRebuilding) {
        // Still rebuilding — restore the indicator (iframe reloaded mid-rebuild)
        setRebuildState("rebuilding")
        // Safety timeout: clear after 5 min to avoid permanently stuck state
        setTimeout(() => {
          if (rebuildState() === "rebuilding") {
            applyRebuildFlagMutation(rebuildFlagMutation("failed"))
            setRebuildState("failed")
            setRebuildError({
              message: "Rebuild timed out",
              fix: [
                "Close the Settings dialog and check the 'Amicode — opencode' output channel.",
                "Try the rebuild again.",
                "If it keeps timing out, report the issue.",
              ],
            })
          }
        }, 300_000)
      } else if (didFinish) {
        // Legacy path (rebuilding flag missing but rebuilt is set)
        localStorage.removeItem("amicode:devtools-rebuilt")
        setRebuildState("rebuilt")
      }
    } catch {
      // non-critical
    }
  })

  // Listen for the extension host's replies
  const handleMessage = (event: MessageEvent) => {
    const d = event.data
    if (d && d.source === "amicode" && d.kind === "dev-tools-status") {
      const next = reduceDevToolsRequest(
        { status: status(), pending: pending() },
        {
          type: "status-received",
          status: {
            opencodeValid: d.opencodeValid ?? true,
            opencodeError: d.opencodeError,
            amicodeValid: d.amicodeValid ?? true,
            amicodeError: d.amicodeError,
            serverRestarted: d.serverRestarted ?? false,
            reloadNeeded: d.reloadNeeded ?? false,
          },
        },
      )
      batch(() => {
        setStatus(next.status)
        setPending(next.pending)
      })

      // When a reload is needed (extension was rebuilt), set a flag so the app
      // reopens settings at the developer tools section after the reload.
      if (d.reloadNeeded) {
        applyRebuildFlagMutation({ set: { reopen: "1", rebuilt: "1" }, clear: [] })
      }
    }

    // Rebuild status messages
    if (d && d.source === "amicode" && d.kind === "dev-tools-rebuild-status") {
      if (d.state === "rebuilding") {
        setRebuildState("rebuilding")
        setRebuildError(undefined)
      } else if (d.state === "failed") {
        applyRebuildFlagMutation(rebuildFlagMutation("failed"))
        setRebuildState("failed")
        // Accept structured errors (new) or flat strings (legacy bridge compat).
        if (d.error && typeof d.error === "object" && typeof d.error.message === "string") {
          setRebuildError({
            message: d.error.message,
            fix: Array.isArray(d.error.fix) ? d.error.fix : [],
            detail: typeof d.error.detail === "string" ? d.error.detail : undefined,
          })
        } else {
          setRebuildError({
            message: typeof d.error === "string" ? d.error : "Unknown error",
            fix: [],
            detail: undefined,
          })
        }
      } else if (d.state === "done") {
        // The extension host confirmed the build finished — set the
        // "rebuilt" flag now (not at rebuild-start) so a dialog reopened
        // after the window reload correctly shows "Rebuilt!" rather than
        // "Rebuilding..." (#940). The window reload follows shortly.
        applyRebuildFlagMutation(rebuildFlagMutation("done"))
      }
    }

    // Devcontainer VSIX build status messages
    if (d && d.source === "amicode" && d.kind === "dev-tools-build-vsix-status") {
      if (d.state === "building") {
        setVsixBuildState("rebuilding")
        setVsixBuildError(undefined)
        setVsixPath(undefined)
      } else if (d.state === "failed") {
        setVsixBuildState("failed")
        setVsixBuildError(d.error ?? "Unknown error")
      } else if (d.state === "done") {
        if (typeof d.vsixPath === "string" && d.vsixPath.trim() !== "") {
          setVsixBuildState("rebuilt")
          setVsixPath(d.vsixPath)
        } else {
          setVsixBuildState("failed")
          setVsixBuildError("Build completed but no output path was reported")
        }
      }
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  }

  const sendUpdate = () => {
    if (!inAmicode()) return
    // Keep the stale status visible (dimmed by the UI via `pending`) instead
    // of blanking it — clearing it here is what caused the validation
    // flicker (#940): every path edit made the error/success indicator
    // vanish and then snap back once the reply arrived.
    const next = reduceDevToolsRequest({ status: status(), pending: pending() }, { type: "request-sent" })
    setPending(next.pending)
    window.parent.postMessage(
      {
        source: "amicode",
        kind: "dev-tools-update",
        enabled: settings.developer.enabled(),
        opencodePath: settings.developer.opencodePath(),
        amicodePath: settings.developer.amicodePath(),
      },
      "*",
    )
  }

  const rebuild = (mode: "local" | "remote") => {
    if (!inAmicode()) return
    if (rebuildState() === "rebuilding") return // prevent double-clicks
    setRebuildState("rebuilding")
    setRebuildError(undefined)
    applyRebuildFlagMutation(rebuildFlagMutation("start"))
    window.parent.postMessage(
      {
        source: "amicode",
        kind: "dev-tools-rebuild",
        mode,
        opencodePath: settings.developer.opencodePath(),
        amicodePath: settings.developer.amicodePath(),
      },
      "*",
    )
  }

  return {
    enabled: settings.developer.enabled,
    setEnabled: (value: boolean) => {
      // Autofill paths with defaults when toggling ON with empty fields
      if (value) {
        if (!settings.developer.opencodePath()) {
          settings.developer.setOpencodePath(DEFAULT_OPENCODE_PATH)
        }
        if (!settings.developer.amicodePath()) {
          settings.developer.setAmicodePath(DEFAULT_AMICODE_PATH)
        }
      }
      settings.developer.setEnabled(value)
      if (value) {
        // Toggle ON: trigger a full rebuild (shows "Rebuilding..." status)
        rebuild("local")
      } else {
        // Toggle OFF: restore marketplace build and reload.
        setRebuildState("rebuilding")
        setRebuildError(undefined)
        if (!inAmicode()) return
        setPending(true)
        setStatus(undefined)
        window.parent.postMessage(
          {
            source: "amicode",
            kind: "dev-tools-update",
            enabled: false,
            opencodePath: settings.developer.opencodePath(),
            amicodePath: settings.developer.amicodePath(),
          },
          "*",
        )
      }
    },
    opencodePath: settings.developer.opencodePath,
    setOpencodePath: (value: string) => {
      settings.developer.setOpencodePath(value)
    },
    amicodePath: settings.developer.amicodePath,
    setAmicodePath: (value: string) => {
      settings.developer.setAmicodePath(value)
    },
    /** Trigger validation + apply on blur — only in developer mode (not devcontainer-only mode) */
    commitOpencodePath: () => {
      if (settings.developer.enabled()) sendUpdate()
    },
    commitAmicodePath: () => {
      if (settings.developer.enabled()) sendUpdate()
    },
    /** Trigger a full rebuild (local = from disk, remote = git pull first) */
    rebuild,
    status,
    pending,
    rebuildState,
    rebuildError,
    // Devcontainer VSIX build
    devcontainerMode: settings.developer.devcontainerMode,
    setDevcontainerMode: (value: boolean) => {
      settings.developer.setDevcontainerMode(value)
    },
    vsixOutputPath: settings.developer.vsixOutputPath,
    setVsixOutputPath: (value: string) => {
      settings.developer.setVsixOutputPath(value)
    },
    buildVsix: () => {
      if (!inAmicode()) return
      if (vsixBuildState() === "rebuilding") return
      setVsixBuildState("rebuilding")
      setVsixBuildError(undefined)
      setVsixPath(undefined)
      window.parent.postMessage({
        source: "amicode",
        kind: "dev-tools-build-vsix",
        opencodePath: settings.developer.opencodePath(),
        amicodePath: settings.developer.amicodePath(),
        outputPath: settings.developer.vsixOutputPath(),
      }, "*")
    },
    vsixBuildState,
    vsixBuildError,
    vsixPath,
  }
}

export type DeveloperToolsController = ReturnType<typeof createDeveloperToolsController>
