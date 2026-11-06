/**
 * preview-html — pure helpers behind the Preview tab's HTML renderer (#2141).
 *
 * A previewed `.html` page is shown in an iframe sandboxed with
 * `allow-same-origin` and WITHOUT `allow-scripts`: nothing in the page runs,
 * and the host can still reach into the frame to route link clicks, apply zoom
 * and keep scroll. That pairing is only safe while scripts stay off — never
 * add `allow-scripts` to that frame.
 *
 * Before display the host prepares the page here: elements that would run
 * code, refresh, re-base or embed are removed, and local image references are
 * collected so the view can inline them as data URIs (a srcdoc document
 * resolves relative URLs against the app's own origin, so a relative `src`
 * would otherwise hit the engine server instead of the file beside the page).
 *
 * @module
 */

export const HTML_EXTENSIONS = [".html", ".htm"] as const

export function isHtmlFile(path: string): boolean {
  const dot = path.lastIndexOf(".")
  if (dot <= 0) return false
  return (HTML_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase())
}

/** Inlining budget: a pathological page must not stall the panel. */
export const MAX_INLINE_IMAGES = 64
export const MAX_INLINE_CHARS = 24_000_000

/**
 * Elements removed outright. Scripts never run in the sandbox anyway; removing
 * them keeps the console quiet. `meta[http-equiv]` covers refresh (the host
 * owns reloading), `base` would re-point every relative URL, and the embedding
 * elements would load content the host does not prepare. `link` is dropped
 * because a relative stylesheet/icon would be requested from the app origin.
 */
const STRIPPED_SELECTOR = [
  "script",
  "noscript",
  "base",
  "meta[http-equiv]",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
].join(", ")

/** Attributes that would make the frame fetch something the host did not prepare. */
const FETCHING_ATTRIBUTES = ["src", "srcset", "poster", "data", "background"] as const

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Join + normalize a POSIX-style path (handles `.` and `..`, keeps a leading `/`). */
function normalizePath(path: string): string {
  const absolute = path.startsWith("/")
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(part)
  }
  const joined = out.join("/")
  return absolute ? `/${joined}` : joined
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  if (slash < 0) return ""
  if (slash === 0) return "/"
  return path.slice(0, slash)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Resolve a URL found in the page to a local file path, or undefined when it is
 * not local (remote, data, blob, mailto, javascript, protocol-relative, empty,
 * or a bare fragment). Relative references resolve against the page's folder;
 * the result is relative when the page path is.
 */
export function resolveLocalRef(ref: string | null | undefined, pagePath: string): string | undefined {
  const raw = (ref ?? "").trim()
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return undefined
  if (SCHEME.test(raw)) {
    if (!/^file:/i.test(raw)) return undefined
    try {
      const path = safeDecode(new URL(raw).pathname)
      return path ? normalizePath(path) : undefined
    } catch {
      return undefined
    }
  }
  const bare = raw.split("#")[0]!.split("?")[0]!
  if (bare === "") return undefined
  const decoded = safeDecode(bare)
  if (decoded.startsWith("/")) return normalizePath(decoded)
  const base = dirname(pagePath)
  return normalizePath(base ? `${base}/${decoded}` : decoded)
}

export type HtmlLinkAction =
  | { kind: "external"; url: string }
  | { kind: "preview"; path: string }
  | { kind: "anchor"; id: string }
  | { kind: "ignore" }

/** What a click on a link inside the previewed page should do. */
export function classifyLink(href: string | null | undefined, pagePath: string): HtmlLinkAction {
  const raw = (href ?? "").trim()
  if (raw === "") return { kind: "ignore" }
  if (raw.startsWith("#")) return raw.length > 1 ? { kind: "anchor", id: safeDecode(raw.slice(1)) } : { kind: "ignore" }
  if (/^https?:\/\//i.test(raw)) return { kind: "external", url: raw }
  if (raw.startsWith("//")) return { kind: "external", url: `https:${raw}` }
  const local = resolveLocalRef(raw, pagePath)
  return local ? { kind: "preview", path: local } : { kind: "ignore" }
}

export interface PreparedHtml {
  /** The cleaned document; image `src` values are rewritten in place by the view. */
  doc: Document
  /** Images with a local source, in document order: the element, the attribute
   *  to rewrite (`src` on `<img>`, `href` on SVG `<image>`), and the file it needs. */
  images: { element: Element; attribute: string; path: string }[]
}

/**
 * Parse and clean a page for display. Parsing with DOMParser never runs
 * scripts. Local image references are left for the caller to inline (async
 * reads); every other attribute that would fetch from the app origin is removed.
 */
export function prepareHtml(html: string, pagePath: string): PreparedHtml {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const element of Array.from(doc.querySelectorAll(STRIPPED_SELECTOR))) element.remove()
  for (const source of Array.from(doc.querySelectorAll("picture source"))) source.remove()

  const images: PreparedHtml["images"] = []
  for (const element of Array.from(doc.querySelectorAll("[src], [srcset], [poster], [data], [background]"))) {
    const tag = element.tagName.toLowerCase()
    for (const attribute of FETCHING_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue
      const value = element.getAttribute(attribute) ?? ""
      if (tag === "img" && attribute === "src") {
        const local = resolveLocalRef(value, pagePath)
        if (local) {
          images.push({ element, attribute: "src", path: local })
          continue
        }
        if (/^(https:|data:)/i.test(value.trim())) continue
      } else if (attribute === "src" && /^(https:|data:)/i.test(value.trim())) {
        continue
      }
      element.removeAttribute(attribute)
    }
  }
  // SVG <image> (inline SVG plots): href / xlink:href — inline local, keep data:/https:.
  for (const element of Array.from(doc.querySelectorAll("image"))) {
    for (const attribute of ["href", "xlink:href"]) {
      if (!element.hasAttribute(attribute)) continue
      const value = element.getAttribute(attribute) ?? ""
      const local = resolveLocalRef(value, pagePath)
      if (local) images.push({ element, attribute, path: local })
      else if (!/^(https:|data:)/i.test(value.trim())) element.removeAttribute(attribute)
    }
  }
  return { doc, images }
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
}

export function imageMimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".")
  return dot > 0 ? IMAGE_MIME[path.slice(dot).toLowerCase()] : undefined
}

/**
 * A data URI for a file.read() result, or undefined when it is not a usable
 * image (unknown type, empty, or a text file that is not SVG).
 */
export function dataUrlFromRead(
  result: { type?: string; content?: string; encoding?: string; mimeType?: string } | null | undefined,
  path: string,
): string | undefined {
  if (!result || typeof result.content !== "string" || result.content === "") return undefined
  const guessed = imageMimeFor(path)
  if (result.type === "text" && result.encoding !== "base64") {
    if (guessed !== "image/svg+xml") return undefined
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.content)}`
  }
  if (result.encoding !== "base64") return undefined
  const mime = result.mimeType && result.mimeType.startsWith("image/") ? result.mimeType : guessed
  if (!mime) return undefined
  return `data:${mime};base64,${result.content}`
}

/** Serialize the prepared document for `srcdoc`. */
export function serializeHtml(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}
