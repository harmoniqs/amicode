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

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
