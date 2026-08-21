// The one-line label for a bash part's row inside the shell group.
//
// Extracted from message-part.tsx so the fallback chain is testable: it caused a
// bug that read as a hard error. While a bash part is PENDING its `input.command`
// is not populated yet, so the chain fell through to the model's free-text
// `description` — and rendered a full prose sentence in the slot where users read
// a command. Reported 2026-07-29 as "a constant error not going away": the text
// was `"A local launch is REFUSED by amico-run while this solver is selected
// (exit 64), so attempting one only wastes…"`, which is agent guidance being
// paraphrased, not a failure — and the solve underneath was running fine.
//
// The description fallback is still worth keeping (often a useful "Install
// dependencies"), so the fix is not to drop it but to stop it impersonating a
// command: strip wrapping quotes, keep one line, and clamp to a length that reads
// as a label rather than an error message.

/** Longest label we render before eliding. Long enough for a real command or a
 *  short description, short enough that prose cannot fill the row. */
export const SHELL_ROW_MAX = 72

export interface ShellRowPartLike {
  state?: {
    input?: Record<string, unknown>
    title?: unknown
  }
}

/** Trim, take the first line, drop wrapping quotes, and elide past SHELL_ROW_MAX. */
export function clampShellLabel(raw: string, max: number = SHELL_ROW_MAX): string {
  let s = raw.split("\n")[0]!.trim()
  // A quoted prose sentence is the shape that read as an error; unwrap it so the
  // row shows the sentence rather than a stray quote mark at the elision point.
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  } else if (s.length >= 1 && (s.startsWith('"') || s.startsWith("'"))) {
    s = s.slice(1).trim()
  }
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + "…"
}

/** Prefer the actual command; fall back to title, then the model's description.
 *  Whatever wins is clamped, so a pending part can never fill the row with prose. */
export function shellRowLabel(part: ShellRowPartLike): string {
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === "string" && input.command.trim() !== "" ? input.command : undefined
  const title = typeof part.state?.title === "string" && part.state.title.trim() !== "" ? part.state.title : undefined
  const description =
    typeof input.description === "string" && input.description.trim() !== "" ? input.description : undefined
  return clampShellLabel(command ?? title ?? description ?? "command")
}
