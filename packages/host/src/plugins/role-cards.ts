// Role-card parity (#2062). `packages/extension/agents/*.md` are written with v1 frontmatter (`permission:` with
// `bash`/`edit` keys). v2 renamed the permission actions (`bash`→`shell`, `write`/`patch`/`apply_patch`→`edit`,
// `task`→`subagent`) and its card loader has two modes: a card with only v1 keys is migrated, but a card that also
// carries any v2-native key (`permissions`, `system`, `request`, `disabled`) is read as native, and its v1
// `permission:` block is then ignored with only a log warning — silently dropping the `deny` of our read-only
// analyzer and hypothesizer. This module translates v1 permission keys to the v2 names and refuses (loudly) any key it
// does not know, so a rule can be renamed but never lost; `renderV2Card` writes the card in the native form.
export class RoleCardError extends Error {}

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** v1 permission key → the v2 action it governs. Keys v2 kept map to themselves; v2 names are accepted as written. */
export const ACTIONS: Readonly<Record<string, string>> = {
  bash: "shell",
  shell: "shell",
  edit: "edit",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  task: "subagent",
  subagent: "subagent",
  read: "read",
  glob: "glob",
  grep: "grep",
  list: "list",
  external_directory: "external_directory",
  todowrite: "todowrite",
  todoread: "todoread",
  question: "question",
  webfetch: "webfetch",
  websearch: "websearch",
  codesearch: "codesearch",
  lsp: "lsp",
  doom_loop: "doom_loop",
  skill: "skill",
}

const EFFECTS = ["allow", "ask", "deny"] as const
const effectOf = (value: unknown, where: string) => {
  if (EFFECTS.includes(value as (typeof EFFECTS)[number])) return value as Rule["effect"]
  throw new RoleCardError(`${where}: ${JSON.stringify(value)} is not allow, ask or deny`)
}

/**
 * v1 `permission:` value → ordered v2 rules (order is policy: the last match wins). A bare effect applies to
 * everything. Throws on a key it cannot place: renaming must never turn into dropping.
 */
export function migratePermission(permission: unknown, source = "card"): Rule[] {
  if (permission === undefined || permission === null) return []
  if (typeof permission === "string") return [{ action: "*", resource: "*", effect: effectOf(permission, `${source}: permission`) }]
  if (typeof permission !== "object" || Array.isArray(permission)) throw new RoleCardError(`${source}: permission must be an effect or a mapping`)
  return Object.entries(permission).flatMap(([key, value]) => {
    const action = key === "*" ? "*" : ACTIONS[key]
    if (action === undefined)
      throw new RoleCardError(`${source}: unknown permission key "${key}" — refusing to drop it. Known keys: ${Object.keys(ACTIONS).join(", ")}`)
    if (typeof value === "string") return [{ action, resource: "*", effect: effectOf(value, `${source}: permission.${key}`) }]
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RoleCardError(`${source}: permission.${key} must be an effect or a pattern mapping`)
    return Object.entries(value).map(([resource, effect]) => ({ action, resource, effect: effectOf(effect, `${source}: permission.${key}["${resource}"]`) }))
  })
}

export interface ParsedCard {
  readonly frontmatter: Record<string, unknown>
  readonly body: string
}

export function parseCard(markdown: string, source = "card"): ParsedCard {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown)
  if (!match) throw new RoleCardError(`${source}: no YAML frontmatter`)
  const frontmatter = Bun.YAML.parse(match[1]!)
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new RoleCardError(`${source}: frontmatter is not a mapping`)
  return { frontmatter: frontmatter as Record<string, unknown>, body: match[2]! }
}

/** The v2 rules a v1 card's frontmatter declares. */
export function cardPermissions(markdown: string, source = "card") {
  return migratePermission(parseCard(markdown, source).frontmatter.permission, source)
}

/**
 * The card rewritten in the v2-native form: `permission:` becomes `permissions:` (renamed actions, order kept), and
 * the v1 sampling keys move to `request.body`, because a native card's unsupported keys are ignored. Everything else
 * is kept as written.
 */
export function renderV2Card(markdown: string, source = "card") {
  const { frontmatter, body } = parseCard(markdown, source)
  const { permission, temperature, top_p, ...rest } = frontmatter
  const sampling = { ...(temperature === undefined ? {} : { temperature }), ...(top_p === undefined ? {} : { top_p }) }
  const native = {
    ...rest,
    ...(Object.keys(sampling).length ? { request: { body: sampling } } : {}),
    permissions: migratePermission(permission, source),
  }
  return `---\n${Bun.YAML.stringify(native, null, 2)}\n---\n${body}`
}
