// Pure part-grouping primitives, extracted from message-part.tsx so they can be
// unit-tested without importing the (Kobalte/DOM-heavy) render module. JSX-free,
// type-only SDK import. message-part.tsx re-exports the public names, so the
// stable `@opencode-ai/ui/message-part` import path is unchanged.
import type { Part as PartType, ToolPart } from "@opencode-ai/sdk/v2"

// Consecutive read/search/list calls collapse into one "Explored" context group;
// consecutive bash calls (≥2) collapse into one "Worked in shell" group (spec B);
// consecutive file-mutation calls (≥2) collapse into one "Edited files" group
// (same spec-B shape — the mutation set mirrors toolDefaultOpen's edit family).
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
const EDIT_GROUP_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function isShellGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && part.tool === "bash"
}

export function isEditGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && EDIT_GROUP_TOOLS.has(part.tool)
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "shell"
      refs: PartRef[]
    }
  | {
      key: string
      type: "edit"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  // context | shell | edit — all carry refs
  if (b.type === "part") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  // At most one run is open at a time: a part is context-group, shell-group,
  // edit-group, or a standalone part. Context collapses at any length (matches
  // read/grep); shell and edit collapse only at ≥2 consecutive calls, so a lone
  // command (or a lone edit, whose inline diff is worth the card) stays full.
  let contextStart = -1
  let shellStart = -1
  let editStart = -1

  const pushPart = (item: { messageID: string; part: PartType }) => {
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: { messageID: item.messageID, partID: item.part.id },
    })
  }

  const flushContext = (end: number) => {
    if (contextStart < 0) return
    const slice = parts.slice(contextStart, end + 1)
    const first = slice[0]
    if (first)
      result.push({
        key: `context:${first.part.id}`,
        type: "context",
        refs: slice.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
      })
    contextStart = -1
  }

  const flushShell = (end: number) => {
    if (shellStart < 0) return
    const slice = parts.slice(shellStart, end + 1)
    const first = slice[0]
    if (first) {
      if (slice.length >= 2)
        result.push({
          key: `shell:${first.part.id}`,
          type: "shell",
          refs: slice.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
        })
      else pushPart(first)
    }
    shellStart = -1
  }

  const flushEdit = (end: number) => {
    if (editStart < 0) return
    const slice = parts.slice(editStart, end + 1)
    const first = slice[0]
    if (first) {
      if (slice.length >= 2)
        result.push({
          key: `edit:${first.part.id}`,
          type: "edit",
          refs: slice.map((item) => ({ messageID: item.messageID, partID: item.part.id })),
        })
      else pushPart(first)
    }
    editStart = -1
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      flushShell(index - 1)
      flushEdit(index - 1)
      if (contextStart < 0) contextStart = index
      return
    }
    if (isShellGroupTool(item.part)) {
      flushContext(index - 1)
      flushEdit(index - 1)
      if (shellStart < 0) shellStart = index
      return
    }
    if (isEditGroupTool(item.part)) {
      flushContext(index - 1)
      flushShell(index - 1)
      if (editStart < 0) editStart = index
      return
    }
    flushContext(index - 1)
    flushShell(index - 1)
    flushEdit(index - 1)
    pushPart(item)
  })

  flushContext(parts.length - 1)
  flushShell(parts.length - 1)
  flushEdit(parts.length - 1)
  return result
}
