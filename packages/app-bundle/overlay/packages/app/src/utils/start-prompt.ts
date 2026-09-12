// amicode: shared prompt-inject helper (extracted from session-new-view.tsx's
// starter chips; also used by the Vaults tab's "Manage vaults" action). Sets
// the composer draft through the prompt context (the submit button's blank()
// gate reads the same store), then clicks the composer's own submit button so
// the REAL handleSubmit runs (worktree resolution, session.create, navigation,
// optimistic UI). Degradation: if no enabled submit button is found, the text
// stays pre-filled and the editor is focused — user hits Enter.
// NOTE: takes the resolved prompt context as an argument — this module is not
// a component and must not call usePrompt() itself.
import type { usePrompt } from "@/context/prompt"

type PromptContext = ReturnType<typeof usePrompt>

export function startPrompt(prompt: PromptContext, text: string) {
  prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
  requestAnimationFrame(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-action="prompt-submit"]:not([disabled])')
    if (button) button.click()
    else document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus()
  })
}

/** Draft-only variant (spec B): prefill the composer and focus it WITHOUT
 *  submitting — used by per-field "Edit in chat" where the user completes the
 *  value first. This is startPrompt's no-submit-button fallback branch,
 *  promoted to a deliberate action. */
export function draftPrompt(prompt: PromptContext, text: string) {
  prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus()
  })
}
