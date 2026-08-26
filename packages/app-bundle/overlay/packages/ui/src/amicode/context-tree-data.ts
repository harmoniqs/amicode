// amicode: THE single mapping from a session's turns to the context tree the
// top panel renders — pure and headless so the shape is testable without the
// sync store. Turns come in message order; each ref is one tool touch already
// mapped by brain-ref. Commits only: searches/globs are transient scouting,
// not context the agent holds, so `consider` refs never enter the tree.
//
// Dedup law: a file/skill/agent enters the tree ONCE, under the turn that
// first pulled it in. A later turn touching the same thing draws a recall
// link back to the existing node instead of duplicating it — the tree stays
// a map of distinct context, not a log.
import type { ContextTreeKind, ContextTreeNodeInput } from "./context-tree-engine"

export type ContextRef = {
  label: string
  type?: string
  path?: string
  consider?: boolean
}

export type ContextTurn = {
  id: string
  refs: ContextRef[]
  /** the turn is still running — its newest touch wears the live cursor */
  busy?: boolean
}

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
]
const roman = (i: number) => ROMAN[i % ROMAN.length]

/** Beyond this many turns the oldest fold into one "· earlier ·" branch so a
 *  marathon session stays a readable tree, not a wall. */
const TURN_CAP = 24

const SOURCE_EXT = /\.(jl|py|ts|tsx|js|jsx|json|toml|yaml|yml|sh|css|html|rs|go|c|h|cpp)$/i
const NOTE_EXT = /\.(md|txt|tex)$/i

export function contextKind(ref: ContextRef): ContextTreeKind {
  if (ref.type === "skill") return "skill"
  if (ref.type === "agent") return "agent"
  if (ref.type === "experiment") return "action"
  if (ref.type === "note") return "note"
  if (ref.path) {
    if (NOTE_EXT.test(ref.path)) return "note"
    if (SOURCE_EXT.test(ref.path)) return "source"
    return "resource"
  }
  if (ref.type === "package") return "source"
  // webfetch hostnames and bash verbs arrive as pathless resources
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(ref.label)) return "web"
  return "resource"
}

/** A path inside an attached vault mount → {mount, rel} so the host can open
 *  it through the Vault panel instead of a project file tab. */
export function vaultRefFromPath(path: string): { mount: string; rel: string } | undefined {
  const m = path.match(/\/\.amico\/vaults\/([^/]+)\/(.+)$/)
  if (m) return { mount: m[1], rel: m[2] }
  return undefined
}

const dedupKey = (ref: ContextRef, kind: ContextTreeKind) =>
  ref.path ? `p:${ref.path}` : `${kind}:${ref.label.toLowerCase()}`

export type ContextTreeOpts = {
  rootLabel?: string
  /** true when the mount refuses browsing (proprietary data/software) — its
   *  leaves render locked: dimmed, padlocked, not openable */
  vaultLocked?: (mount: string) => boolean
}

export function buildContextTree(turns: ContextTurn[], opts: ContextTreeOpts = {}): ContextTreeNodeInput {
  const root: ContextTreeNodeInput = {
    id: "root",
    label: opts.rootLabel ?? "amico",
    kind: "root",
    children: [],
  }
  let visible = turns
  let offset = 0
  if (turns.length > TURN_CAP) {
    // fold the overflow into one quiet branch; its refs still claim dedup
    // keys so later recalls point somewhere real
    const folded = turns.slice(0, turns.length - TURN_CAP)
    visible = turns.slice(turns.length - TURN_CAP)
    offset = folded.length
    const earlier: ContextTreeNodeInput = {
      id: "turn-earlier",
      label: `· ${folded.length} earlier turns ·`,
      kind: "turn",
      children: [],
      recalls: [],
    }
    root.children!.push(earlier)
    const seen = seenOf(root)
    for (const t of folded)
      for (const ref of t.refs) {
        if (ref.consider) continue
        const kind = contextKind(ref)
        const key = dedupKey(ref, kind)
        if (seen.has(key)) continue
        seen.set(key, `ctx-${seen.size}`)
        earlier.children!.push(leafOf(ref, kind, seen.get(key)!, opts))
      }
  }
  const seen = seenOf(root)
  let lastLeaf: ContextTreeNodeInput | undefined
  visible.forEach((turn, i) => {
    const n = offset + i
    // turn branches are anonymous roman numerals BY DESIGN (Kate, 2026-07-28):
    // the tree surfaces only the context amico checks and the scripts it
    // writes — user prompt text must never enter it. Don't re-add excerpts.
    const node: ContextTreeNodeInput = {
      id: `turn-${turn.id}`,
      label: roman(n),
      kind: "turn",
      children: [],
      recalls: [],
    }
    for (const ref of turn.refs) {
      if (ref.consider) continue
      const kind = contextKind(ref)
      const key = dedupKey(ref, kind)
      const known = seen.get(key)
      if (known) {
        if (!node.recalls!.includes(known)) node.recalls!.push(known)
        continue
      }
      const id = `ctx-${seen.size}`
      seen.set(key, id)
      const leaf = leafOf(ref, kind, id, opts)
      node.children!.push(leaf)
      lastLeaf = leaf
    }
    // a turn that only recalled things it already holds still charts — the
    // recall links ARE its story
    root.children!.push(node)
    if (turn.busy) {
      const cursor = lastLeaf && node.children!.includes(lastLeaf) ? lastLeaf : node
      cursor.active = true
    }
  })
  return root
}

function leafOf(ref: ContextRef, kind: ContextTreeKind, id: string, opts: ContextTreeOpts): ContextTreeNodeInput {
  const vault = ref.path ? vaultRefFromPath(ref.path) : undefined
  return {
    id,
    label: ref.label.slice(0, 32),
    kind,
    path: ref.path,
    vault: !!vault,
    locked: vault && opts.vaultLocked ? opts.vaultLocked(vault.mount) : undefined,
  }
}

/** Rebuild the dedup index from a partially-built tree (used by the fold). */
function seenOf(root: ContextTreeNodeInput): Map<string, string> {
  const seen = new Map<string, string>()
  const walk = (n: ContextTreeNodeInput) => {
    for (const c of n.children ?? []) {
      if (c.kind !== "turn" && c.kind !== "root")
        seen.set(c.path ? `p:${c.path}` : `${c.kind}:${c.label.toLowerCase()}`, c.id)
      walk(c)
    }
  }
  walk(root)
  return seen
}
