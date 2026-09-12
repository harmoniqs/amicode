import type { QuestionInfo } from "@opencode-ai/sdk/v2"

// Question-shape rules for the session question dock (amicode#245). Extracted
// from the component so the rendering contract is unit-testable: a Free-form
// Question (kind: "text") renders a text card — the header plus a bare text
// input with submit, no option rows and no typed-custom-answer pseudo-option —
// while a Choice Question renders its options and shows the pseudo-option row
// only when the question allows a custom answer.

/** True when the question renders as a text card (no option list). */
export function questionText(info: Pick<QuestionInfo, "kind"> | undefined): boolean {
  return info?.kind === "text"
}

/** True when the typed-custom-answer row renders: choice questions that allow
 *  a custom answer (the TUI flag check the dock previously ignored). */
export function questionCustomRow(info: Pick<QuestionInfo, "kind" | "custom"> | undefined): boolean {
  if (questionText(info)) return false
  return info?.custom !== false
}

/** A text card's submit is enabled only once the trimmed text is non-empty. */
export function questionTextReady(input: string): boolean {
  return input.trim().length > 0
}
