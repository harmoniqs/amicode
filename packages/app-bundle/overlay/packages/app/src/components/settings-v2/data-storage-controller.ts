import { createSignal, onCleanup, onMount } from "solid-js"
import { useSettings } from "@/context/settings"
import { inAmicode } from "@/utils/amicode-bridge"

export interface DataStorageStatus {
  databaseValid: boolean
  databaseError?: string
  configValid: boolean
  configError?: string
  serverRestarted: boolean
}

export interface DataStorageDefaults {
  databasePath: string
  configDir: string
  recapWindowDays: number
}

export function createDataStorageController() {
  const settings = useSettings()
  const [status, setStatus] = createSignal<DataStorageStatus | undefined>(undefined)
  const [defaults, setDefaults] = createSignal<DataStorageDefaults | undefined>(undefined)
  const [pending, setPending] = createSignal(false)

  // On mount, query the extension host for the resolved default paths
  onMount(() => {
    if (!inAmicode()) return
    window.parent.postMessage(
      {
        source: "amicode",
        kind: "data-storage-query",
      },
      "*",
    )
  })

  // Listen for the extension host's replies
  const handleMessage = (event: MessageEvent) => {
    const d = event.data
    if (!d || d.source !== "amicode") return

    // Defaults reply (on mount)
    if (d.kind === "data-storage-defaults") {
      setDefaults({
        databasePath: typeof d.databasePath === "string" ? d.databasePath : "",
        configDir: typeof d.configDir === "string" ? d.configDir : "",
        recapWindowDays: typeof d.recapWindowDays === "number" ? d.recapWindowDays : 7,
      })
    }

    // Status reply (after update)
    if (d.kind === "data-storage-status") {
      setStatus({
        databaseValid: d.databaseValid ?? true,
        databaseError: d.databaseError,
        configValid: d.configValid ?? true,
        configError: d.configError,
        serverRestarted: d.serverRestarted ?? false,
      })
      setPending(false)
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
        kind: "data-storage-update",
        databasePath: settings.storage.databasePath(),
        configDir: settings.storage.configDir(),
        recapWindowDays: settings.storage.recapWindowDays(),
      },
      "*",
    )
  }

  return {
    databasePath: settings.storage.databasePath,
    setDatabasePath: (value: string) => {
      settings.storage.setDatabasePath(value)
    },
    configDir: settings.storage.configDir,
    setConfigDir: (value: string) => {
      settings.storage.setConfigDir(value)
    },
    recapWindowDays: settings.storage.recapWindowDays,
    setRecapWindowDays: (value: number) => {
      settings.storage.setRecapWindowDays(value)
    },
    /** Trigger validation + apply on blur */
    commitDatabasePath: () => sendUpdate(),
    commitConfigDir: () => sendUpdate(),
    commitRecapWindowDays: () => sendUpdate(),
    status,
    defaults,
    pending,
  }
}

export type DataStorageController = ReturnType<typeof createDataStorageController>
