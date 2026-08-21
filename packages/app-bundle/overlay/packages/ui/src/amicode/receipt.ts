// AMICODE: single consumer of the AMICODE_DIFF sentinel wire (spec A —
// amicode_tools.ts sentinelLine). The sentinel is the LAST line of an
// amicode_* tool return: `AMICODE_DIFF {problem, entity, action, seq, diff}`.
// Strict parse; ANY failure → undefined and callers fall back to the legacy
// chip, so old sessions keep rendering. Never throws.

import { compactValue } from "./facets"

const PREFIX = "AMICODE_DIFF "

export type DiffEntry = { from: unknown; to: unknown }
export type DiffSentinel = {
  problem: string
  entity: string
  action: string
  seq?: number
  diff: Record<string, DiffEntry>
}

export function parseDiffSentinel(output: unknown): DiffSentinel | undefined {
  if (typeof output !== "string") return undefined
  const lines = output.trimEnd().split("\n")
  const last = lines[lines.length - 1]
  if (!last?.startsWith(PREFIX)) return undefined
  try {
    const raw = JSON.parse(last.slice(PREFIX.length))
    if (typeof raw !== "object" || raw === null) return undefined
    if (typeof raw.entity !== "string" || typeof raw.action !== "string") return undefined
    const diff: Record<string, DiffEntry> = {}
    if (typeof raw.diff === "object" && raw.diff !== null)
      for (const [key, value] of Object.entries(raw.diff as Record<string, any>))
        diff[key] = { from: value?.from ?? null, to: value?.to ?? null }
    return {
      problem: typeof raw.problem === "string" ? raw.problem : "",
      entity: raw.entity,
      action: raw.action,
      seq: typeof raw.seq === "number" ? raw.seq : undefined,
      diff,
    }
  } catch {
    return undefined
  }
}

// Entities with a live in-transcript view (card.tsx's InlineEntityView, fed by
// the entity rail) instead of just a diff chip. Whether any GIVEN receipt for
// one of these renders as the chip or the live view depends on
// receipt-currency.ts's receiptIsCurrent (reactive, live-problem-view state) —
// so anything keying off this set (e.g. receipt-runs.ts) must treat it as "no
// safe static answer" rather than guessing.
export const INLINE_KINDS = new Set(["system", "formulation", "run", "device_session", "calibration"])

export const ENTITY_LABELS: Record<string, string> = {
  system: "System",
  formulation: "Formulation",
  run: "Run",
  device_session: "Device",
  calibration: "Calibration",
  problem: "Problem",
}
export function entityLabel(kind: string): string {
  const known = ENTITY_LABELS[kind]
  if (known) return known
  const raw = kind.replaceAll("_", " ")
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : kind
}

function short(value: unknown): string {
  return compactValue(value) // spec §4: array/object-aware, never a JSON blob
}

// A receipt's body, broken into typed pieces so the UI can render each change
// as a discrete unit (dimmed old value · arrow · new value) instead of a flat
// string. `receiptText` below joins these back into the exact one-line form the
// legacy chip and the tests expect — the structured and string renders never
// diverge because they come from the same source.
export type ReceiptChange =
  | { kind: "elision" }
  | { kind: "set"; key: string; to: string }
  | { kind: "change"; key: string; from: string; to: string }
export type ReceiptParts = { label: string; changes: ReceiptChange[]; action: string }

export function receiptParts(sentinel: DiffSentinel): ReceiptParts {
  const changes: ReceiptChange[] = Object.entries(sentinel.diff).map(([key, entry]) => {
    if (key === "…") return { kind: "elision" }
    const bare = key.split(".").pop() ?? key
    if (entry.from === null || entry.from === undefined) return { kind: "set", key: bare, to: short(entry.to) }
    return { kind: "change", key: bare, from: short(entry.from), to: short(entry.to) }
  })
  return { label: entityLabel(sentinel.entity), changes, action: sentinel.action }
}

/** `System · levels 3→4 · omega 4.8` — dotted diff keys render bare (last
 *  segment); creates (from null) render value-only; the spec-A elision key
 *  `…` renders as a bare ellipsis. Empty diff → the action. One line, always. */
export function receiptText(sentinel: DiffSentinel): string {
  const { label, changes, action } = receiptParts(sentinel)
  const parts = changes.map((change) => {
    if (change.kind === "elision") return "…"
    if (change.kind === "set") return `${change.key} ${change.to}`
    return `${change.key} ${change.from}→${change.to}`
  })
  const body = parts.length > 0 ? parts.join(" · ") : action
  return `${label} · ${body}`
}

/** For any raw-output display path: drop a trailing sentinel line. NOTE: the
 *  current fork has NO such path — card.tsx deliberately never renders the raw
 *  tool return, and amicode_* parts never reach GenericTool (message-part.tsx
 *  routes them all to AmicodeToolCard). Exported + tested so the spec's strip
 *  rule holds by construction if a raw path is ever added. */
export function stripSentinel(output: unknown): string {
  if (typeof output !== "string") return ""
  const lines = output.trimEnd().split("\n")
  if (lines[lines.length - 1]?.startsWith(PREFIX)) lines.pop()
  return lines.join("\n").trimEnd()
}
