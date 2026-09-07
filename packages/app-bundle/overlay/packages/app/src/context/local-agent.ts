export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

/** The picker's visibility rule (#208): show when there is an actual CHOICE —
 *  a custom agent (upstream behavior) OR more than one selectable agent, so a
 *  native plan/build pair keeps its escalation affordance when a server ships
 *  no custom agents (plan-first posture, read-only default). */
export function hasAgentChoice<T extends { native?: boolean }>(items: T[]) {
  return hasCustomAgent(items) || items.length > 1
}

// ── the mode-id read-resolve alias (spec-20260907-011500 D1, #858) ──────────
// autodev → develop, autoresearch → research. READ-RESOLVE, never
// migrate-on-write: a persisted session selection carrying an old id binds
// the renamed card at read time. `build` is NOT aliased — it exits the
// picker, not the vocabulary. The alias window's exit rides the next
// mode-bundle CONTRACT-VERSION bump.
const MODE_ID_ALIASES: Record<string, string> = {
  autodev: "develop",
  autoresearch: "research",
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  const wanted = name === undefined ? undefined : MODE_ID_ALIASES[name] ?? name
  return items.find((item) => item.name === wanted) ?? items.find((item) => item.name === "build") ?? items[0]
}

/** Picker ordering (#868 rev 3 — the fixed order plan → build → develop →
 *  research, fork PR #305's `agent_order` semantics honored APP-SIDE per the
 *  overlay architecture): `agent_order` is the PRIMARY sort key — listed
 *  agents in
 *  declared order, unlisted agents after every listed one; the
 *  `default_agent` pin is the secondary key among the unlisted, then
 *  alphabetical (exactly #305's sortBy precedence). No config, and the list
 *  passes through unchanged (stock behavior for a standalone server). */
export function orderByPickerConfig<T extends { name: string }>(
  items: T[],
  config?: { agent_order?: string[]; default_agent?: string } | undefined,
): T[] {
  const order = config?.agent_order
  if (!order || order.length === 0) return items
  const indexOf = (name: string) => {
    const i = order.indexOf(name)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const isDefault = (name: string) => (config?.default_agent ? name === config.default_agent : name === "build")
  return [...items].sort(
    (a, b) => indexOf(a.name) - indexOf(b.name) || Number(isDefault(b.name)) - Number(isDefault(a.name)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** The default posture (#868 rev 3): stock `build` is a NAMED, selectable
 *  tile AND the default posture. It renders under its own name marked
 *  default — not implied-absent (#858's original D1, amended by real usage:
 *  plain work — authoring, one-off fixes — is distinct from develop's
 *  campaign machinery). */
export function isDefaultAgent(name: string): boolean {
  return name === "build"
}

export interface AgentPickerOption {
  name: string
  default: boolean
}

/** Map a picker agent name to its option shape: the default posture carries
 *  the marker (the label renders the i18n'd suffix). */
export function markedAgent(name: string, _defaultLabel?: string): AgentPickerOption {
  return { name, default: isDefaultAgent(name) }
}
