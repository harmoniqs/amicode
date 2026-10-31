// #1403: pure pieces of the Preview's Compile button (the JSX lives in
// preview-file-view.tsx). The button posts the SAME `run-latex` message Cmd+S
// uses after a save, and reflects the host's `run-latex-status` lifecycle.

export type CompileState = "idle" | "compiling" | "done" | "error"
export type CompileStatus = { state: Exclude<CompileState, "idle">; detail?: string }

/** The success check fades back to the idle icon after this long. */
export const COMPILE_DONE_FADE_MS = 2500

/** Is this a LaTeX source the compile bridge accepts (`.tex` / `.ltx`)? */
export const isLatexFile = (path: string): boolean => /\.(tex|ltx)$/i.test(path)

/** The existing compile request (same path Cmd+S takes) — absolute, because the
 *  bridge silently rejects relative paths. Works on a clean, unmodified file. */
export const compileRequestMessage = (absolutePath: string) =>
  ({ source: "amicode", kind: "run-latex", file: absolutePath }) as const

/** Click idempotence: a compile already in flight is never started a second time
 *  (the host also coalesces; this keeps the button from queueing a rerun). */
export const canStartCompile = (state: CompileState): boolean => state !== "compiling"

const normalize = (path: string): string => path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")

/** Map a `run-latex-status` message to this file's button status, or undefined if
 *  it is not about this file. Matches the path as REQUESTED as well as the
 *  host's (symlink-resolved) `file`. `latexmk` missing surfaces as an error. */
export const compileStatusFromMessage = (data: unknown, selfAbsolute: string): CompileStatus | undefined => {
  if (!data || typeof data !== "object") return undefined
  const msg = data as { source?: unknown; kind?: unknown; state?: unknown; file?: unknown; requested?: unknown; error?: unknown }
  if (msg.source !== "amicode" || msg.kind !== "run-latex-status") return undefined
  const self = normalize(selfAbsolute)
  const matches = [msg.requested, msg.file].some((candidate) => typeof candidate === "string" && normalize(candidate) === self)
  if (!matches) return undefined
  switch (msg.state) {
    case "compiling":
      return { state: "compiling" }
    case "done":
      return { state: "done" }
    case "error":
      return typeof msg.error === "string" && msg.error !== "" ? { state: "error", detail: msg.error } : { state: "error" }
    case "unavailable":
      return { state: "error", detail: "latexmk was not found — install a TeX distribution to compile" }
    default:
      return undefined
  }
}
