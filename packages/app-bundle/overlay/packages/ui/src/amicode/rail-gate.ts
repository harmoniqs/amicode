// Does THIS session's transcript show amicode work? The entity rail renders only
// when it does, so a fresh or non-amicode session shows no empty chrome (the
// active problem pointer is global, the rail is session-scoped).
//
// Extracted from entity-rail.tsx to be testable, and broadened. The original test
// was `part.tool.startsWith("amicode_")` — a session that did its amicode work
// through the SHELL therefore showed no chips at all. Observed 2026-07-29: the
// agent created a problem workspace, wrote a solvespec, and launched a solve that
// reached iteration 29 with frames on disk — entirely via bash and `amico-run` —
// and the rail stayed hidden the whole time, because it never called an
// `amicode_*` tool. The chips had real entities to describe and refused to.
//
// A shell-driven solve is still unambiguously an amicode session, so the gate now
// also recognises a bash part whose command drives amicode. It stays SESSION-scoped
// (the point of the gate), so an unrelated session still shows nothing.

/** Substrings in a shell command that mark it as amicode work. `amico-run` is the
 *  launcher; the problems dir is where a workspace gets created before any run. */
const SHELL_MARKERS = ["amico-run", ".amico/problems", "amico plan", "amico spec"] as const

export interface GatePartLike {
  type?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
  }
}

function isAmicodeToolPart(part: GatePartLike): boolean {
  return part?.type === "tool" && typeof part.tool === "string" && part.tool.startsWith("amicode_")
}

/** A shell part that drives amicode. Reads only `input.command`, so a part whose
 *  input has not arrived yet simply doesn't match (it will on the next render). */
function isAmicodeShellPart(part: GatePartLike): boolean {
  if (part?.type !== "tool") return false
  const command = part.state?.input?.command
  if (typeof command !== "string") return false
  return SHELL_MARKERS.some((marker) => command.includes(marker))
}

export interface AmicodePartCounts {
  /** Parts that mark this as an amicode session — the render gate. */
  any: number
  /** Completed `amicode_*` tool parts — the refetch key. Deliberately NOT
   *  broadened: shell parts don't mutate the problem view through the tool seam,
   *  so counting them would refetch on unrelated shell activity. */
  completed: number
}

export function countAmicodeParts<T extends GatePartLike>(
  messages: readonly { id: string }[],
  partsFor: (messageID: string) => readonly T[] | undefined,
): AmicodePartCounts {
  let any = 0
  let completed = 0
  for (const message of messages) {
    for (const part of partsFor(message.id) ?? []) {
      if (isAmicodeToolPart(part)) {
        any++
        if (part.state?.status === "completed") completed++
      } else if (isAmicodeShellPart(part)) {
        any++
      }
    }
  }
  return { any, completed }
}

/** The rail's session gate, exported so the host chrome can collapse the header's
 *  chip padding when the rail will not render. */
export function sessionHasAmicodeParts<T extends GatePartLike>(
  messages: readonly { id: string }[],
  partsFor: (messageID: string) => readonly T[] | undefined,
): boolean {
  return countAmicodeParts(messages, partsFor).any > 0
}
