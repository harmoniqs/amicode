// Candidate 3: a stock `opencode serve --port N` (NO --service) child process, proxied by the host.
import { sandbox, freePort } from "../env"
import type { Target } from "../options"

export async function build(): Promise<Target> {
  const port = await freePort()
  // A stock process cannot receive an in-process plugin, but it does load file plugins named in global config:
  // write one so criterion C7b can show what the stock route *can* do.
  const pluginDir = `${sandbox.root}/file-plugin`
  await Bun.write(
    `${pluginDir}/index.js`,
    `export default { id: "h0c-file", async setup(ctx) { await ctx.rpc.register({ id: "h0cfile", methods: { ping: { input: { type: "object" }, output: { type: "string" } } }, events: {} }, { ping: async () => "pong-from-file-plugin" }) } }\n`,
  )
  await Bun.write(`${process.env.XDG_CONFIG_HOME}/opencode/opencode.json`, JSON.stringify({ plugins: [pluginDir] }))
  const innerPassword = "h0c-inner-throwaway"
  const started = performance.now()
  const child = Bun.spawn(
    ["bun", "run", "--cwd", `${sandbox.upstream}/packages/cli`, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: sandbox.workDir,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME!,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME!,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME!,
        OPENCODE_TEST_HOME: process.env.OPENCODE_TEST_HOME!,
        OPENCODE_DB: sandbox.dbPath,
        OPENCODE_PASSWORD: innerPassword,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_FILEWATCHER_DISABLE: "1",
        OPENCODE_DISABLE_FFF: "1",
        H0C_SUBS_LOG: sandbox.subsLog,
      },
      stdout: Bun.file(`${sandbox.root}/c3-stdout.log`),
      stderr: Bun.file(`${sandbox.root}/c3-stderr.log`),
    },
  )
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  for (;;) {
    if (Date.now() > deadline) throw new Error("stock serve did not come up in 90s")
    const ok = await fetch(`${url}/api/info`, {
      headers: { authorization: "Basic " + Buffer.from(`opencode:${innerPassword}`).toString("base64") },
    }).then((r) => r.status === 200, () => false)
    if (ok) break
    await Bun.sleep(300)
  }
  return {
    nativeUrl: url,
    nativeAuth: true,
    customRouteInBare: false,
    filePluginId: "h0c-file",
    registerPlugin: undefined, // separate process: no in-process handle (file-config plugins are tested separately)
    workspaceProbe: undefined,
    facts: { "startup ms": Math.round(performance.now() - started), port, pid: child.pid, innerPassword },
    stop: async () => {
      child.kill("SIGTERM")
      await child.exited
    },
  }
}
