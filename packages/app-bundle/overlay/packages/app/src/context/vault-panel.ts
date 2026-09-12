// amicode: the Vault panel's open-state + pending file target. A module-scope
// singleton (one drawer per window) rather than a provider — the panel and its
// callers (context-tree clicks, the rail button, the command palette) live in
// unrelated subtrees, and threading a context through all of them buys nothing.
import { createSignal } from "solid-js"

export type VaultFileTarget = { mount: string; path: string }

const [opened, setOpened] = createSignal(false)
const [target, setTarget] = createSignal<VaultFileTarget | undefined>(undefined)

export const vaultPanel = {
  opened,
  /** the file the panel should show once open (set by context-tree clicks) */
  target,
  open(t?: VaultFileTarget) {
    if (t) setTarget(t)
    setOpened(true)
  },
  close() {
    setOpened(false)
  },
  toggle() {
    setOpened((x) => !x)
  },
  clearTarget() {
    setTarget(undefined)
  },
}
