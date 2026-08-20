// AMICODE: TOML-subset reader for human/agent-authored widget manifests.
// Deliberately small — scalars (string/int/float/bool), string arrays,
// [table] / [table.sub] nesting, [[array-of-tables]], comments. No dotted
// keys in assignments, no dates, no inline tables. The server only READS
// TOML (manifests); dashboard state is JSON. Same never-throw discipline as
// problems.ts: one result shape, ok:false with "code: detail" on bad input.

export type TomlLiteResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

const BARE_KEY = /^[A-Za-z0-9_-]+$/

/** Parse one scalar token: quoted string, bool, number. */
function scalar(raw: string): { ok: true; value: unknown } | { ok: false } {
  const s = raw.trim()
  if (s.length === 0) return { ok: false }
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0]
    let out = ""
    let i = 1
    while (i < s.length) {
      const c = s[i]
      if (c === "\\" && q === '"' && i + 1 < s.length) {
        const n = s[i + 1]
        out += n === "n" ? "\n" : n === "t" ? "\t" : n
        i += 2
        continue
      }
      if (c === q) {
        // rest must be whitespace or a comment
        const rest = s.slice(i + 1).trim()
        if (rest !== "" && !rest.startsWith("#")) return { ok: false }
        return { ok: true, value: out }
      }
      out += c
      i++
    }
    return { ok: false } // unterminated
  }
  // strip trailing comment on unquoted values
  const hash = s.indexOf("#")
  const body = (hash >= 0 ? s.slice(0, hash) : s).trim()
  if (body === "true") return { ok: true, value: true }
  if (body === "false") return { ok: true, value: false }
  if (/^-?\d+$/.test(body)) return { ok: true, value: Number.parseInt(body, 10) }
  if (/^-?\d*\.\d+$/.test(body)) return { ok: true, value: Number.parseFloat(body) }
  return { ok: false }
}

/** Split a bracketed array body into item tokens (strings only supported). */
function stringArray(body: string): { ok: true; value: string[] } | { ok: false } {
  const items: string[] = []
  let i = 0
  const s = body.trim()
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === "," || s[i] === "\t")) i++
    if (i >= s.length) break
    const q = s[i]
    if (q !== '"' && q !== "'") return { ok: false }
    let out = ""
    i++
    while (i < s.length && s[i] !== q) {
      if (s[i] === "\\" && q === '"' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
        continue
      }
      out += s[i]
      i++
    }
    if (i >= s.length) return { ok: false } // unterminated
    i++ // closing quote
    items.push(out)
  }
  return { ok: true, value: items }
}

export function parseTomlLite(src: string): TomlLiteResult {
  const root: Record<string, unknown> = {}
  let current = root
  const lines = src.split("\n")
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln].trim()
    if (line === "" || line.startsWith("#")) continue

    // [[array.of.tables]]
    if (line.startsWith("[[")) {
      if (!line.endsWith("]]")) return { ok: false, error: `line ${ln + 1}: malformed table array header` }
      const path = line.slice(2, -2).trim().split(".")
      if (path.some((p) => !BARE_KEY.test(p))) return { ok: false, error: `line ${ln + 1}: bad table array name` }
      let node = root
      for (const part of path.slice(0, -1)) {
        const next = node[part]
        if (next === undefined) {
          const t: Record<string, unknown> = {}
          node[part] = t
          node = t
        } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
          node = next as Record<string, unknown>
        } else return { ok: false, error: `line ${ln + 1}: table array path conflicts with value` }
      }
      const last = path[path.length - 1]
      const arr = node[last]
      const entry: Record<string, unknown> = {}
      if (arr === undefined) node[last] = [entry]
      else if (Array.isArray(arr)) arr.push(entry)
      else return { ok: false, error: `line ${ln + 1}: table array conflicts with value` }
      current = entry
      continue
    }

    // [table] / [table.sub]
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) return { ok: false, error: `line ${ln + 1}: malformed table header` }
      const path = line.slice(1, -1).trim().split(".")
      if (path.some((p) => !BARE_KEY.test(p))) return { ok: false, error: `line ${ln + 1}: bad table name` }
      let node = root
      for (const part of path) {
        const next = node[part]
        if (next === undefined) {
          const t: Record<string, unknown> = {}
          node[part] = t
          node = t
        } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
          node = next as Record<string, unknown>
        } else return { ok: false, error: `line ${ln + 1}: table path conflicts with value` }
      }
      current = node
      continue
    }

    // key = value
    const eq = line.indexOf("=")
    if (eq < 0) return { ok: false, error: `line ${ln + 1}: expected key = value` }
    const key = line.slice(0, eq).trim()
    if (!BARE_KEY.test(key)) return { ok: false, error: `line ${ln + 1}: bad key ${JSON.stringify(key)}` }
    if (Object.prototype.hasOwnProperty.call(current, key))
      return { ok: false, error: `line ${ln + 1}: duplicate key ${key}` }
    let value = line.slice(eq + 1).trim()

    // array — may span lines until the closing bracket
    if (value.startsWith("[")) {
      while (!value.includes("]") && ln + 1 < lines.length) {
        ln++
        value += " " + lines[ln].trim()
      }
      const close = value.lastIndexOf("]")
      if (close < 0) return { ok: false, error: `line ${ln + 1}: unterminated array` }
      const rest = value.slice(close + 1).trim()
      if (rest !== "" && !rest.startsWith("#")) return { ok: false, error: `line ${ln + 1}: junk after array` }
      const arr = stringArray(value.slice(1, close))
      if (!arr.ok) return { ok: false, error: `line ${ln + 1}: bad string array` }
      current[key] = arr.value
      continue
    }

    const sc = scalar(value)
    if (!sc.ok) return { ok: false, error: `line ${ln + 1}: bad value for ${key}` }
    current[key] = sc.value
  }
  return { ok: true, value: root }
}
