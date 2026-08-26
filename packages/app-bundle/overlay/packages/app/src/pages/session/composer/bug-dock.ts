// amicode#116/#117: the bug dock's open-state seam. The composer's report-a-bug
// button consults this singleton: dock OPEN → reveal/re-expand (no bridge
// post); dock absent/closed → post amicode.reportBug and let the extension
// host open the flow. A module-scope singleton (one dock per window), the
// vault-panel pattern — slice #117 builds the real dock UI against this API:
// it owns open()/close(); the button only ever reads isOpen() and calls
// reveal(). Never drive open/close from the button side.
import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)
const [nonce, setNonce] = createSignal(0)

export const bugDock = {
  /** true while the dock is live (mounted/open, even if momentarily collapsed). */
  isOpen: open,
  /** #117: the dock becomes visible (mounted or un-dismissed). */
  open() {
    setOpen(true)
  },
  /** #117: the dock fully dismisses — the next click posts the bridge command. */
  close() {
    setOpen(false)
  },
  /**
   * Bring an open dock back into view (re-expand from collapsed). Bumps a
   * generation nonce so an already-open dock still gets an observable signal —
   * #117 watches revealNonce() to re-expand; never a bridge post.
   */
  reveal() {
    setOpen(true)
    setNonce((n) => n + 1)
  },
  /** #117: generation counter for reveal() — re-expand trigger for an open dock. */
  revealNonce: nonce,
}
