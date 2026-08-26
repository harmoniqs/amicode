import { createSignal, onCleanup, onMount } from "solid-js"
import { inAmicode } from "@/utils/amicode-bridge"

export interface SkillProviderEntry {
  id: string
  type: "directory" | "url"
  path?: string
  url?: string
  added: string
  cache_path?: string
}

export function createSkillProvidersController() {
  const [providers, setProviders] = createSignal<SkillProviderEntry[]>([])
  const [discoveredPaths, setDiscoveredPaths] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)

  // On mount, query the extension host for the current providers
  onMount(() => {
    if (!inAmicode()) {
      setLoading(false)
      return
    }
    window.parent.postMessage({ source: "amicode", kind: "skill-providers-query" }, "*")
  })

  // Listen for the extension host's replies
  const handleMessage = (event: MessageEvent) => {
    const d = event.data
    if (!d || d.source !== "amicode") return

    if (d.kind === "skill-providers-data") {
      setProviders(Array.isArray(d.providers) ? d.providers : [])
      setLoading(false)
    }

    if (d.kind === "skill-providers-discovered") {
      setDiscoveredPaths(Array.isArray(d.paths) ? d.paths : [])
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  }

  const addDirectory = () => {
    if (!inAmicode()) return
    window.parent.postMessage({ source: "amicode", kind: "skill-providers-pick-directory" }, "*")
  }

  const addProvider = (provider: SkillProviderEntry) => {
    if (!inAmicode()) return
    window.parent.postMessage({ source: "amicode", kind: "skill-providers-add", provider }, "*")
  }

  const removeProvider = (id: string) => {
    if (!inAmicode()) return
    window.parent.postMessage({ source: "amicode", kind: "skill-providers-remove", id }, "*")
  }

  const autodiscover = () => {
    if (!inAmicode()) return
    window.parent.postMessage({ source: "amicode", kind: "skill-providers-autodiscover" }, "*")
  }

  return {
    providers,
    discoveredPaths,
    loading,
    addDirectory,
    addProvider,
    removeProvider,
    autodiscover,
  }
}

export type SkillProvidersController = ReturnType<typeof createSkillProvidersController>
