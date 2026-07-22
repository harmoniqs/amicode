import { randomBytes } from "node:crypto";

// ============================================================================
// Per-boot server password (#163, ADR 0002 graft 1).
//
// The vendored fork's route auth (packages/opencode/src/server/auth.ts @
// v1.17.3-amicode.5) only engages when OPENCODE_SERVER_PASSWORD is set in the
// server's env — without it, every route (including the amicode mutation
// routes) is open to any localhost page. The extension therefore mints a
// cryptographically random password once per activation and injects it into
// EVERY `opencode serve` spawn env.
//
// Carriage (all three read base64("opencode:<password>"), verified at the tag):
//   - the extension's own HTTP/SSE calls → `Authorization: Basic …` header
//   - the chat iframe / fork app        → `?auth_token=…` query param, which
//     the app's entry consumes for its authenticated-fetch path and strips
//     from the URL bar (history.replaceState) before rendering
//
// Lifetime: in-memory only for the life of the activation — never persisted,
// never logged. Respawns within one activation (solver-mode switch, vault
// refresh, restartServer) REUSE the value: the open chat iframe holds the
// boot credential, so a mid-session rotation would strand it on 401s. A new
// activation mints a new value.
// ============================================================================

/** The fork resolves its Basic-auth username from OPENCODE_SERVER_USERNAME ??
 *  "opencode" — and the spawned server INHERITS the host env, so a dev override
 *  there must shape our credential too or every extension call 401s. */
function serverUsername(): string {
  return process.env.OPENCODE_SERVER_USERNAME || "opencode";
}

/** Mint the per-boot server password: 32 random bytes, base64url so it rides
 *  env vars and the auth_token query param unescaped. */
export function mintServerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** The `?auth_token=` value the fork's auth middleware and the app's entry
 *  bootstrap both decode: base64("opencode:<password>"). */
export function serverAuthToken(password: string): string {
  return Buffer.from(`${serverUsername()}:${password}`).toString("base64");
}

/** The `Authorization` header for the extension's own calls to the server —
 *  mirrors the fork's ServerAuth.header (Basic, username "opencode"). */
export function serverAuthHeader(password: string): string {
  return `Basic ${serverAuthToken(password)}`;
}

/** Build the env the extension ADDS to the opencode server spawn (the server
 *  inherits the host env underneath — ServerManager spreads process.env):
 *    PATH                     — amico-run launcher dir prepended, so solves run
 *    OPENCODE_CONFIG_CONTENT  — the amico instructions/permission merge
 *    OPENCODE_SERVER_PASSWORD — arms the fork's route auth (this module)
 *  One builder for all spawn sites so no respawn path can drop the password. */
/** Non-secret path/config overrides passed THROUGH to the server when set in
 *  the extension host's env. The minimal-env discipline stands — this is a
 *  fixed allowlist of amico state locations (never a process.env spread), so a
 *  sandbox launch (`AMICO_PASQAL_FILE=… code …`) can isolate its ~/.amico +
 *  keychain from the real install. None of these are secrets; unset vars never
 *  appear. */
const SANDBOX_ENV_PASSTHROUGH = [
  "AMICO_CLOUD_FILE",
  "AMICO_PASQAL_FILE",
  "AMICODE_CONNECTIONS_FILE",
  "AMICODE_OPS_DIR",
  "AMICO_PASQAL_KEYCHAIN_SERVICE",
  "AMICO_PASQAL_VALIDATOR",
  "AMICO_PYTHON",
] as const

export function buildServerSpawnEnv(opts: {
  /** amico-run launcher bin dir; undefined = launcher missing (boot warns). */
  amicoRunBinDir: string | undefined;
  /** buildOpencodeConfigContent(...) output for this spawn. */
  configContent: string;
  /** The per-boot password from mintServerPassword(). */
  serverPassword: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${opts.amicoRunBinDir ? opts.amicoRunBinDir + ":" : ""}${process.env.PATH ?? ""}`,
    OPENCODE_CONFIG_CONTENT: opts.configContent,
    OPENCODE_SERVER_PASSWORD: opts.serverPassword,
  };
  for (const key of SANDBOX_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}
