// amicode: THE single mapping from a tool call to its brain-graph reference —
// the node label the brain page uses, the brain node type, and whether the
// touch is a commit (pulse travels, node claims) or a consider (scout flash
// that may leak back to dark). Consumed by the chat's hover glances
// (message-part) and the brain strip's touch stream (packages/app
// brain-strip.tsx). Labels must match the brain page's node ids — skills map
// by bare name; unknown files graft new nodes.
export type AmicoBrainRef = {
  label: string
  type: string
  consider: boolean
  /** full file path when the touch IS a file — lets the context tree open it */
  path?: string
}

export function amicoBrainRef(tool: string, input: Record<string, unknown> = {}): AmicoBrainRef | undefined {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const base = (p: string) => p.split("/").pop() ?? p
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "apply_patch": {
      const fp = str(input.filePath) ?? str(input.path)
      if (!fp) return undefined
      const label = base(fp)
      const type = /\.(md|txt)$/i.test(label) ? "note" : /\.jl$/i.test(label) ? "package" : "resource"
      return { label, type, consider: false, path: fp }
    }
    case "grep":
    case "glob": {
      const pattern = str(input.pattern)
      return pattern ? { label: pattern.slice(0, 24), type: "resource", consider: true } : undefined
    }
    case "list": {
      const p = str(input.path)
      return { label: p ? base(p) : "files", type: "resource", consider: true }
    }
    case "websearch": {
      const q = str(input.query)
      return q ? { label: q.slice(0, 24), type: "resource", consider: true } : undefined
    }
    case "webfetch": {
      const url = str(input.url)
      if (!url) return undefined
      try {
        return { label: new URL(url).hostname, type: "resource", consider: false }
      } catch {
        return undefined
      }
    }
    case "task":
      return { label: str(input.subagent_type) ?? "agent", type: "agent", consider: false }
    case "skill": {
      const name = str(input.name)
      return name ? { label: name, type: "skill", consider: false } : undefined
    }
    case "bash": {
      const cmd = str(input.command) ?? ""
      const desc = str(input.description)
      if (/amico-run|julia/.test(cmd)) return { label: desc?.slice(0, 28) ?? "solve run", type: "experiment", consider: false }
      return desc ? { label: desc.slice(0, 28), type: "resource", consider: false } : undefined
    }
    case "question":
      // the interview asking the user IS the pulse-designer score at work
      return { label: "pulse-designer", type: "skill", consider: false }
    default:
      // amicode plugin tools (amicode_problem, amicode_pick_system, …) are the
      // product's own verbs — map each by its most identifying argument
      if (tool.startsWith("amicode_")) {
        const label =
          str(input.name) ?? str(input.system) ?? str(input.family) ?? str(input.id) ?? tool.slice(8).replace(/_/g, " ")
        return { label: label.slice(0, 28), type: "resource", consider: false }
      }
      return undefined // todowrite, MCP — not part of the visible thought
  }
}

/** Hovering a tool row glances at its node on the map — decoupled via a DOM
 *  event so this package stays ignorant of the brain host. */
export function emitAmicoBrainHover(ref: AmicoBrainRef | undefined) {
  if (!ref || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("amicode:brain-hover", { detail: { label: ref.label } }))
}
