import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

// AMICODE: the user's paper library — PDFs uploaded from the home page that
// make Amico smarter about THIS user's work. Files land in ~/.amico/library;
// the amicode extension grants the agent's file tools read access to that dir,
// so "read the paper I just added" works with zero further plumbing. Same
// never-reject discipline as problems.ts: every body is a JSON string.

export function libraryRoot(): string {
  const env = process.env.AMICODE_LIBRARY_DIR
  if (env && env.trim() !== "") return env
  return path.join(os.homedir(), ".amico", "library")
}

export function synthesizeLibrary(code: string, detail: string): string {
  return JSON.stringify({ ok: false, papers: [], error: `${code}: ${detail}` })
}

const MAX_BYTES = 30 * 1024 * 1024 // a 30MB PDF is a book; bigger is a mistake

/** Basename-only, conservative charset, single .pdf suffix. */
export function sanitizeFilename(raw: string): string | null {
  const base = path.basename(raw).trim()
  if (!/\.pdf$/i.test(base)) return null
  const clean = base
    .slice(0, -4)
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
  return clean === "" ? null : `${clean}.pdf`
}

export function libraryBody(root: string = libraryRoot()): string {
  try {
    if (!existsSync(root)) return JSON.stringify({ ok: true, papers: [], error: null })
    const papers = readdirSync(root)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => {
        const st = statSync(path.join(root, f))
        return { name: f, size: st.size, added_ms: Math.round(st.mtimeMs), path: path.join(root, f) }
      })
      .sort((a, b) => b.added_ms - a.added_ms)
    return JSON.stringify({ ok: true, papers, error: null })
  } catch (err) {
    return synthesizeLibrary("bad_output", String(err))
  }
}

/** Save one uploaded paper (JSON body: {filename, data_b64}). Returns the
 *  refreshed listing on success so the client renders in one round-trip. */
export function saveLibraryFile(rawBody: string, root: string = libraryRoot()): string {
  let parsed: { filename?: unknown; data_b64?: unknown }
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return synthesizeLibrary("bad_request", "body must be JSON {filename, data_b64}")
  }
  if (typeof parsed.filename !== "string" || typeof parsed.data_b64 !== "string")
    return synthesizeLibrary("bad_request", "filename and data_b64 are required strings")
  const name = sanitizeFilename(parsed.filename)
  if (!name) return synthesizeLibrary("bad_filename", "PDFs only; name must survive sanitization")
  let bytes: Buffer
  try {
    bytes = Buffer.from(parsed.data_b64, "base64")
  } catch {
    return synthesizeLibrary("bad_request", "data_b64 is not valid base64")
  }
  if (bytes.length === 0) return synthesizeLibrary("bad_request", "empty file")
  if (bytes.length > MAX_BYTES) return synthesizeLibrary("too_large", `max ${MAX_BYTES} bytes`)
  // magic check: every real PDF opens with %PDF-
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    return synthesizeLibrary("bad_filetype", "not a PDF (missing %PDF- header)")
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, name), bytes)
  } catch (err) {
    return synthesizeLibrary("write_failed", String(err))
  }
  return libraryBody(root)
}
