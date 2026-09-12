// amicode#203 (Kate): only ONE chrome-strip dropdown open at a time. Each
// dropdown announces itself when it opens; the others watch the shared signal
// and close. Module-level signal — the chrome strip is a singleton surface.
import { createSignal } from "solid-js"

const [openId, setOpenId] = createSignal<string | undefined>(undefined)

/** Announce that a chrome dropdown just opened (closes the others). */
export function announceChromeDropdown(id: string): void {
  setOpenId(id)
}

/** The id of the currently-open chrome dropdown (reactive). */
export function chromeDropdownOpenId(): string | undefined {
  return openId()
}

/** Clear the announcement when a dropdown closes itself. */
export function clearChromeDropdown(id: string): void {
  if (openId() === id) setOpenId(undefined)
}
