// AMICODE: the Pasqal password store (amicode#194, ADR 0001 addendum
// 2026-07-21). Pasqal's API accepts ONLY password-grant and service-account
// tokens — refresh tokens 403, browser/device grants are client-disabled — so
// a user connection needs the password present to silently re-mint the ~24h
// token. This is the ONE place a third-party password is kept, and it is kept
// in the OS keychain, NEVER in the credential file (the credentials.ts poison
// guard makes a password in pasqal.json impossible by design).
//
// Mechanism is Jack's validated pasqalAuth.ts choice (Kate, 2026-07-21):
// @napi-rs/keyring — macOS login Keychain / Linux Secret Service / Windows
// Credential Manager, the same native module already riding the bun-compiled
// binary alongside node-pty and tree-sitter. Where the native binding cannot
// load (headless Linux, no Secret Service daemon), the store degrades to
// SESSION-MEMORY: the password lives in this process only and a restart
// re-prompts — ADR 0001's original named fallback, never a plaintext file.
//
// SECURITY: the password value never appears in a log, an error message, a
// status entry, or any rendered response — this module returns it only to the
// re-auth spawn, which passes it via the child env (never argv).

/** Keychain service (namespace) for the Pasqal password. $AMICO_PASQAL_KEYCHAIN_SERVICE
 *  overrides the default so an isolated sandbox / test run gets its own slot and
 *  never shares the real connection's secret. */
function keychainService(): string {
  const env = process.env.AMICO_PASQAL_KEYCHAIN_SERVICE
  return env && env.trim() !== "" ? env.trim() : "pasqal-cloud"
}

export interface PasqalSecret {
  username: string
  password: string
}

/** The store seam. Every method is failure-tolerant: a keychain that cannot be
 *  reached never throws into the caller — read() is undefined, write() reports
 *  false so the caller can fall back to session-only, clear() is best-effort. */
export interface PasqalSecretStore {
  read(account: string): PasqalSecret | undefined
  /** true = durably stored (survives restart); false = not persisted (the
   *  caller should treat the connection as session-only). */
  write(account: string, secret: PasqalSecret): boolean
  clear(account: string): void
}

/** Lazily-loaded @napi-rs/keyring Entry constructor, or null if the native
 *  module is absent/unloadable in this runtime. Resolved once. */
let keyringEntry: (new (service: string, account: string) => KeyringEntry) | null | undefined
interface KeyringEntry {
  getPassword(): string
  setPassword(value: string): void
  deletePassword(): void
}

function loadKeyring(): (new (service: string, account: string) => KeyringEntry) | null {
  if (keyringEntry !== undefined) return keyringEntry
  try {
    // require, not static import: the native binding must not be a hard
    // load-time dependency of the whole server — a missing/unbuilt addon
    // degrades this one feature, it does not crash opencode.
    const mod = require("@napi-rs/keyring") as { Entry: new (service: string, account: string) => KeyringEntry }
    keyringEntry = mod.Entry
  } catch {
    keyringEntry = null
  }
  return keyringEntry
}

/** Session-memory fallback: a process-lifetime map, keyed by account. Used
 *  when the keychain is unreachable so the interim still works within one run
 *  (silent re-mint mid-session) even on a keyring-less host. */
const sessionMemory = new Map<string, PasqalSecret>()

/** Production store: keychain when available, session-memory otherwise. */
export const keychainSecretStore: PasqalSecretStore = {
  read(account) {
    const Entry = loadKeyring()
    if (Entry) {
      try {
        const raw = new Entry(keychainService(), account).getPassword()
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === "object" && parsed !== null) {
          const d = parsed as Record<string, unknown>
          if (typeof d.username === "string" && typeof d.password === "string" && d.username !== "" && d.password !== "")
            return { username: d.username, password: d.password }
        }
      } catch {
        // no entry / unreadable / off-shape → fall through to session memory
      }
    }
    return sessionMemory.get(account)
  },
  write(account, secret) {
    const Entry = loadKeyring()
    if (Entry) {
      try {
        new Entry(keychainService(), account).setPassword(JSON.stringify(secret))
        sessionMemory.delete(account) // durable now wins; don't keep a RAM copy too
        return true
      } catch {
        // keychain present but write refused (locked, no daemon) → session only
      }
    }
    sessionMemory.set(account, secret)
    return false
  },
  clear(account) {
    sessionMemory.delete(account)
    const Entry = loadKeyring()
    if (!Entry) return
    try {
      new Entry(keychainService(), account).deletePassword()
    } catch {
      // nothing stored / already gone — clear is best-effort
    }
  },
}

/** Test-only: an injectable in-memory store so suites never touch the real OS
 *  keychain. Behaves like the durable path (write → true). */
export function inMemorySecretStore(): PasqalSecretStore {
  const map = new Map<string, PasqalSecret>()
  return {
    read: (account) => map.get(account),
    write: (account, secret) => {
      map.set(account, secret)
      return true
    },
    clear: (account) => void map.delete(account),
  }
}

// The active store — production default, swappable by tests via setSecretStore.
let active: PasqalSecretStore = keychainSecretStore

export function pasqalSecretStore(): PasqalSecretStore {
  return active
}

/** Test seam: install a store (e.g. inMemorySecretStore()); returns a restore fn. */
export function setPasqalSecretStore(store: PasqalSecretStore): () => void {
  const prev = active
  active = store
  return () => {
    active = prev
  }
}
