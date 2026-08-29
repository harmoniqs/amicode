import { createSignal, onCleanup, onMount } from "solid-js"
import { useSettings } from "@/context/settings"
import { inAmicode } from "@/utils/amicode-bridge"

export interface DevToolsStatus {
  opencodeValid: boolean
  opencodeError?: string
  amicodeValid: boolean
  amicodeError?: string
  serverRestarted: boolean
  reloadNeeded: boolean
  building?: boolean
  buildError?: string
}

export type RebuildState = "idle" | "rebuilding" | "rebuilt" | "failed"

/** Default repo paths autofilled when the toggle is turned ON with empty fields. */
const DEFAULT_OPENCODE_PATH = "~/harmoniqs/opencode"
const DEFAULT_AMICODE_PATH = "~/harmoniqs/amicode"

export function createDeveloperToolsController() {
  const settings = useSettings()
  const [status, setStatus] = createSignal<DevToolsStatus | undefined>(undefined)
  const [pending, setPending] = createSignal(false)
  const [rebuildState, setRebuildState] = createSignal<RebuildState>("idle")
  const [rebuildError, setRebuildError] = createSignal<string | undefined>(undefined)
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
            try { localStorage.removeItem("amicode:devtools-rebuilding") } catch {}
            setRebuildState("failed")
            setRebuildError("Rebuild timed out")
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
      setStatus({
        opencodeValid: d.opencodeValid ?? true,
        opencodeError: d.opencodeError,
        amicodeValid: d.amicodeValid ?? true,
        amicodeError: d.amicodeError,
        serverRestarted: d.serverRestarted ?? false,
        reloadNeeded: d.reloadNeeded ?? false,
        building: d.building ?? false,
        buildError: d.buildError,
      })
      setPending(false)

      // When a reload is needed (extension was rebuilt), set a flag so the app
      // reopens settings at the developer tools section after the reload.
      if (d.reloadNeeded) {
        try {
          localStorage.setItem("amicode:devtools-reopen", "1")
          localStorage.setItem("amicode:devtools-rebuilt", "1")
        } catch {
          // localStorage unavailable — non-critical
        }
      }
    }

    // Rebuild status messages
    if (d && d.source === "amicode" && d.kind === "dev-tools-rebuild-status") {
      if (d.state === "rebuilding") {
        setRebuildState("rebuilding")
        setRebuildError(undefined)
      } else if (d.state === "failed") {
        try { localStorage.removeItem("amicode:devtools-rebuilding") } catch {}
        setRebuildState("failed")
        setRebuildError(d.error ?? "Unknown error")
      } else if (d.state === "done") {
        try { localStorage.removeItem("amicode:devtools-rebuilding") } catch {}
        // The window reload follows shortly — "rebuilt" flag is read on next mount
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
    setPending(true)
    setStatus(undefined)
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
    try {
      localStorage.setItem("amicode:devtools-rebuilding", "1")
      localStorage.setItem("amicode:devtools-reopen", "1")
      localStorage.setItem("amicode:devtools-rebuilt", "1")
    } catch {
      // non-critical
    }
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
