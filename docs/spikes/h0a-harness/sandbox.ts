// The sandbox every H0a process runs in: temp XDG dirs and HOME, a fresh database file, a random password in a 0600
// file, no inherited inspector or credentials. Nothing here points at ~/.amico, ~/.config/systemd or
// ~/.local/share/opencode, and it refuses a run directory that is not under /tmp.
import fs from "node:fs"
import path from "node:path"
import { assertPort } from "./common.ts"

export type Sandbox = ReturnType<typeof makeSandbox>

export function makeSandbox(root: string) {
  const abs = path.resolve(root)
  if (!abs.startsWith("/tmp/")) throw new Error(`H0a run directories live under /tmp, not ${abs}`)
  const dirs = {
    state: path.join(abs, "sbx", "state"),
    data: path.join(abs, "sbx", "data"),
    config: path.join(abs, "sbx", "config"),
    cache: path.join(abs, "sbx", "cache"),
    home: path.join(abs, "sbx", "home"),
    work: path.join(abs, "sbx", "work"),
    serverConfig: path.join(abs, "sbx", "server-config"),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  const passwordFile = path.join(abs, "sbx", "password")
  const password = crypto.randomUUID()
  fs.writeFileSync(passwordFile, password, { mode: 0o600 })
  fs.chmodSync(passwordFile, 0o600)
  return { root: abs, ...dirs, db: path.join(dirs.data, "amicode-host.db"), password, passwordFile }
}

/** The host's environment: from scratch (nothing inherited but PATH), pointed at the paced model. */
export function hostEnv(sb: Sandbox, options: { port: number; providerConfig: object }) {
  assertPort(options.port)
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sb.home,
    OPENCODE_TEST_HOME: sb.home,
    XDG_STATE_HOME: sb.state,
    XDG_DATA_HOME: sb.data,
    XDG_CONFIG_HOME: sb.config,
    XDG_CACHE_HOME: sb.cache,
    OPENCODE_DB: sb.db,
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    AMICODE_HOST_DB: sb.db,
    AMICODE_HOST_PASSWORD_FILE: sb.passwordFile,
    AMICODE_HOST_PORT: String(options.port),
    // Default plugin set (default-deny permission policy) with no injected context blocks; no grants, so `shell` is refused.
    AMICODE_HOST_PLUGIN_CONFIG: JSON.stringify({ context: { extensionDir: null } }),
    AMICODE_HOST_SERVER_OPTIONS: JSON.stringify({
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(options.providerConfig) },
    }),
  }
}
