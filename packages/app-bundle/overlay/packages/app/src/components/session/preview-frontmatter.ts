// AMICODE: YAML front matter for the Preview tab's markdown view.
//
// marked has no front-matter support: the opening `---` rendered as a rule and
// the closing `---` turned every key line into one giant setext <h2>. We split
// the block off and render it as a properties card instead.
//
// Deliberately a small, dependency-free parser for the flat shape vault notes
// use (scalars, quoted strings, inline [a, b] lists, block `- item` lists).
// Anything it can't read keeps the raw YAML (shown verbatim) — never a guess.

export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[]

export type FrontmatterEntry = { key: string; value: FrontmatterValue }

export type Frontmatter =
  | { kind: "parsed"; entries: FrontmatterEntry[]; raw: string }
  | { kind: "raw"; raw: string }

export type SplitMarkdown = { frontmatter?: Frontmatter; body: string }

const OPEN = /^\uFEFF?---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/

/** Split a leading front-matter block off a markdown document. A document
 *  without one (or with an unterminated one) comes back untouched. */
export function splitFrontmatter(text: string): SplitMarkdown {
  const open = OPEN.exec(text)
  if (!open) return { body: text }
  const rest = text.slice(open[0].length)
  const lines = rest.split(/\r?\n/)
  const end = lines.findIndex((line) => CLOSE.test(line))
  if (end < 0) return { body: text }
  const raw = lines.slice(0, end).join("\n")
  const body = lines.slice(end + 1).join("\n").replace(/^\s*\n/, "")
  if (raw.trim() === "") return { body }
  const entries = parseFlatYaml(raw)
  return { frontmatter: entries ? { kind: "parsed", entries, raw } : { kind: "raw", raw }, body }
}

function stripComment(value: string): string {
  // a ` #` outside quotes starts a comment
  let quote: string | undefined
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (quote) {
      if (c === quote && value[i - 1] !== "\\") quote = undefined
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === "#" && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trimEnd()
  }
  return value
}

function unquote(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return undefined
}

function scalar(input: string): FrontmatterValue {
  const value = input.trim()
  const quoted = unquote(value)
  if (quoted !== undefined) return quoted
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null
  if (value === "true" || value === "True") return true
  if (value === "false" || value === "False") return false
  if (/^-?\d+(\.\d+)?$/.test(value) && value.length < 16 && !/^-?0\d/.test(value)) return Number(value)
  return value
}

/** Split an inline list body on top-level commas (quotes and [[wikilinks]] kept whole). */
function splitInline(body: string): string[] | undefined {
  const items: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ""
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (quote) {
      current += c
      if (c === quote && body[i - 1] !== "\\") quote = undefined
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if (c === "[") depth++
    if (c === "]") depth--
    if (depth < 0) return undefined
    if (c === "," && depth === 0) {
      items.push(current)
      current = ""
      continue
    }
    current += c
  }
  if (quote || depth !== 0) return undefined
  if (current.trim() !== "" || items.length > 0) items.push(current)
  return items.map((item) => item.trim()).filter((item) => item !== "")
}

function inlineValue(input: string): FrontmatterValue | undefined {
  const value = stripComment(input.trim())
  if (value.startsWith("[") && value.endsWith("]") && !value.startsWith("[[")) {
    const items = splitInline(value.slice(1, -1))
    if (!items) return undefined
    return items.map((item) => scalar(item))
  }
  if (value.startsWith("{")) return undefined // flow maps: keep raw
  if (value === "|" || value === ">" || /^[|>][+-]?\d*$/.test(value)) return undefined // block scalars handled by caller
  return scalar(value)
}

/** Parse flat key/value YAML. undefined = a shape this parser won't guess at. */
export function parseFlatYaml(raw: string): FrontmatterEntry[] | undefined {
  const lines = raw.split("\n")
  const entries: FrontmatterEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "" || /^\s*#/.test(line)) continue
    const match = /^([A-Za-z0-9_][\w.\- ]*?)\s*:(?:\s+(.*)|\s*)$/.exec(line)
    if (!match) return undefined
    const key = match[1]!.trim()
    const rest = match[2] ?? ""
    // block scalar: `key: |` / `key: >` followed by indented lines
    if (/^[|>][+-]?\s*$/.test(rest.trim())) {
      const fold = rest.trim().startsWith(">")
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
        block.push(lines[++i]!.trim())
      }
      entries.push({ key, value: fold ? block.join(" ").trim() : block.join("\n").trim() })
      continue
    }
    if (rest.trim() === "") {
      // block list: indented `- item` lines; anything else indented is nested
      const items: FrontmatterValue[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
        const item = inlineValue(lines[++i]!.replace(/^\s*-\s+/, ""))
        if (item === undefined || Array.isArray(item)) return undefined
        items.push(item)
      }
      if (items.length === 0 && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) return undefined
      entries.push({ key, value: items.length > 0 ? items : null })
      continue
    }
    const value = inlineValue(rest)
    if (value === undefined) return undefined
    entries.push({ key, value })
  }
  return entries
}

/** A value worth showing: not null / "" / [] (empty properties are noise). */
export function isPresent(value: FrontmatterValue): boolean {
  if (value === null) return false
  if (typeof value === "string") return value.trim() !== ""
  if (Array.isArray(value)) return value.some(isPresent)
  return true
}

/** `[[target]]` / `[[target|alias]]` → { target, label }, else undefined. */
export function wikilink(value: string): { target: string; label: string } | undefined {
  const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim())
  if (!match) return undefined
  return { target: match[1]!.trim(), label: (match[2] ?? match[1]!).trim() }
}

/** Keys promoted into the card's header line, in display order. */
export const HEADER_KEYS = ["type", "status", "date", "confidence", "visibility"] as const
