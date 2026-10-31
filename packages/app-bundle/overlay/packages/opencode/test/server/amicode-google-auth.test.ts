// AMICODE: Google / Google Drive browser sign-in start (harmoniqs/amicode#624).
// Without a configured OAuth client the old handler opened accounts.google.com's
// generic sign-in page (which just shows the user's existing logged-in session)
// and claimed "waiting-browser" — a dead end. It must now refuse up front with
// actionable guidance (where to get a token) and never open a browser.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { GOOGLE_TOKEN_GUIDANCE, setBindHostname, startAuthResponse } from "@/server/amicode/connections"

const ENV_KEYS = ["BROWSER", "GOOGLE_CLIENT_ID", "GOOGLE_REDIRECT_URI"] as const
let saved: Record<string, string | undefined>
let dir: string
let marker: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  dir = mkdtempSync(path.join(tmpdir(), "amicode-google-auth-"))
  marker = path.join(dir, "opened.txt")
  // A fake system browser: records the URL it was asked to open.
  const script = path.join(dir, "fake-browser.sh")
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`)
  chmodSync(script, 0o755)
  process.env.BROWSER = script
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_REDIRECT_URI
  setBindHostname(undefined)
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setBindHostname(undefined)
})

const settle = () => new Promise((r) => setTimeout(r, 150))

describe("startAuthResponse — google/google-drive (#624)", () => {
  for (const id of ["google", "google-drive"]) {
    test(`${id}: no OAuth client configured → refusal with token guidance, browser never opened`, async () => {
      const out = JSON.parse(await startAuthResponse(JSON.stringify({ id, method: "browser" })))
      expect(out.ok).toBe(false)
      expect(out.connection).toBeNull()
      expect(out.error).toStartWith("google_app_not_configured:")
      expect(out.error).toContain("GOOGLE_CLIENT_ID")
      expect(out.error).toContain("oauthplayground")
      await settle()
      expect(existsSync(marker)).toBe(false)
    })
  }

  test("guidance names where to obtain a token and the scopes per connector", () => {
    expect(GOOGLE_TOKEN_GUIDANCE["google-drive"]).toContain("developers.google.com/oauthplayground")
    expect(GOOGLE_TOKEN_GUIDANCE["google-drive"]).toContain("drive.file")
    expect(GOOGLE_TOKEN_GUIDANCE["google-drive"]).toContain("spreadsheets")
    expect(GOOGLE_TOKEN_GUIDANCE.google).toContain("gmail.readonly")
  })

  test("OAuth client configured → real Google consent URL opened, waiting-browser returned", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com"
    const out = JSON.parse(await startAuthResponse(JSON.stringify({ id: "google-drive", method: "browser" })))
    expect(out.ok).toBe(true)
    expect(out.connection.state).toBe("waiting-browser")
    await settle()
    const opened = readFileSync(marker, "utf8")
    expect(opened).toStartWith("https://accounts.google.com/o/oauth2/v2/auth?")
    expect(opened).toContain("client_id=client-123.apps.googleusercontent.com")
    expect(opened).not.toContain("signin/v2/identifier")
  })
})
