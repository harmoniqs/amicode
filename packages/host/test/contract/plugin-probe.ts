// Child process (sandboxed by plugin.test.ts): the plugin registration entry point the host builds on.
// Builds the routes exactly as server-seam.ts does, registers an in-process plugin through
// `SdkPlugins.Service.register`, and reports what the server then shows. Prints one JSON line.
const { createRoutes } = await import("@opencode/server/routes")
const { SdkPlugins } = await import("@opencode/core/plugin/sdk")
const { Context, Effect, Exit, Layer, Scope } = await import("effect")
const { HttpEffect, HttpRouter, HttpServer } = await import("effect/http")

const dir = process.env.CONTRACT_WORK_DIR!
const scope = await Effect.runPromise(Scope.make())
const context = await Effect.runPromise(
  Layer.buildWithScope(
    createRoutes(
      { app: { name: "contract", version: "0" }, database: { path: process.env.OPENCODE_DB! }, models: { fetch: false }, fs: { filewatcher: false, fff: false }, config: { project: false, claude: false, content: "{}", directory: process.env.CONTRACT_CONFIG_DIR! } } as never,
      () => [],
    ).pipe(Layer.provide(HttpServer.layerServices)),
    scope,
  ),
)
const plugins = Context.get(context, SdkPlugins.Service)
const before = plugins.all().length
const ran: string[] = []
await Effect.runPromise(plugins.register({ id: "contract.probe", effect: () => Effect.sync(() => void ran.push("effect-ran")) }))
const after = plugins.all().length

const app = Context.get(context, HttpRouter.HttpRouter).asHttpEffect() as never
const handler = HttpEffect.toWebHandlerWith(context)(app)
const get = (route: string) => handler(new Request("http://localhost" + route, { headers: { "x-opencode-directory": dir } }))
// A Location-scoped request boots the Location; booting loads the registered plugins' effects (the "ordinary
// generation path"). Poll briefly: the effect runs in the Location's own fiber.
const booted = await get("/api/agent")
for (let i = 0; i < 60 && ran.length === 0; i++) await Bun.sleep(50)
const listed = await get("/api/plugin")
const body = (await listed.json()) as { data?: unknown }

console.log(
  JSON.stringify({
    registerIsFunction: typeof plugins.register === "function",
    allIsFunction: typeof plugins.all === "function",
    before,
    after,
    bootStatus: booted.status,
    listedStatus: listed.status,
    listedIsArray: Array.isArray(body.data),
    ran,
  }),
)
await Effect.runPromise(Scope.close(scope, Exit.void))
process.exit(0)
