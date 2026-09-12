type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell", { example: input.example })
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}

// Mirrored from amicode's overlay (upstream v1.18.29 contract): the design
// placeholder takes the translate callback and calls it in the non-shell
// branch — a 2-arg call passes undefined there and throws "n is not a
// function" on every non-shell composer render. The amicode hard-coded brand
// line ("Ask Amico anything, ...") is superseded by the translated key the
// ui locales already carry. See harmoniqs/amicode#929/#964.
export function promptDesignPlaceholder(
  mode: PromptPlaceholderInput["mode"],
  placeholder: string,
  t: PromptPlaceholderInput["t"],
) {
  if (mode === "shell") return placeholder
  return t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" })
}
