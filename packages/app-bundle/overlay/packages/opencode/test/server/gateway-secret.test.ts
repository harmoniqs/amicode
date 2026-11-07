import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import {
  GatewaySecret,
  gatewaySecretLayer,
} from "../../src/server/routes/instance/httpapi/middleware/gateway-secret"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { serveUIEffect } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

const fsUtilLayer = AppNodeBuilder.build(FSUtil.node)
const it = testEffect(Layer.mergeAll(fsUtilLayer, RuntimeFlags.layer()))

function secretConfigLayer(secret?: string) {
  return GatewaySecret.Config.configLayer({
    sharedSecret: secret === undefined ? Option.none() : Option.some(secret),
  })
}

// A minimal router with the global gateway-secret middleware — the same
// provision position createRoutes uses (global middleware provided to the
// route layers). The router is fully provided, so its handler needs no
// request context.
function gatewayApp(secret?: string) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        yield* router.add("GET", "/hello", () => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true })))
        yield* router.add("POST", "/hello", () => Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true })))
      }),
    ).pipe(
      Layer.provide(gatewaySecretLayer.pipe(Layer.provide(secretConfigLayer(secret)))),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string, init?: RequestInit) {
      return Effect.promise(() => Promise.resolve(handler(new Request(new URL(input, "http://localhost"), init))))
    },
  }
}

function httpClient(response: Response, onRequest?: (request: HttpClientRequest.HttpClientRequest) => void) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )
}

// The SPA-fallback router (same shape as the real uiRoute): the catch-all
// serves serveUIEffect, so the SSE guard must fire before any UI serving.
function uiApp(secret?: string) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(gatewaySecretLayer.pipe(Layer.provide(secretConfigLayer(secret)))),
      Layer.provide([
        fsUtilLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
        httpClient(new Response("<html>the app</html>", { headers: { "content-type": "text/html" } })),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string, init?: RequestInit) {
      return Effect.promise(() => Promise.resolve(handler(new Request(new URL(input, "http://localhost"), init))))
    },
  }
}

// The FULL engine route tree (HttpApiApp.routes = createRoutes()) — proves the
// middleware is wired into the real server assembly, not just the minimal
// harness. Config arrives via ConfigProvider, exactly like env in production.
// The tree has route requirements, so its handler takes the module context —
// the same call shape as httpapi-ui.test.ts's app().
function fullApp(env: Record<string, string | undefined>) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ...env })),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(handler(new Request(new URL(input, "http://localhost"), init), HttpApiApp.context)),
      )
    },
  }
}

describe("gateway-secret middleware (#1760 P1: one door)", () => {
  it.live("secret set: request without the header is 401 JSON, never HTML", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("s3cret").request("/hello")
      expect(response.status).toBe(401)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = yield* Effect.promise(() => response.text())
      expect(body.startsWith("<")).toBe(false)
      expect(JSON.parse(body).error).toBeTruthy()
    }),
  )

  it.live("secret set: wrong secret is 401 JSON", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("s3cret").request("/hello", {
        headers: { "x-amicode-gateway-secret": "wrong" },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get("content-type")).toContain("application/json")
    }),
  )

  it.live("secret set: matching header is 200", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("s3cret").request("/hello", {
        headers: { "x-amicode-gateway-secret": "s3cret" },
      })
      expect(response.status).toBe(200)
    }),
  )

  it.live("secret set: POSTs are guarded too (every API route)", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("s3cret").request("/hello", { method: "POST" })
      expect(response.status).toBe(401)
      const ok = yield* gatewayApp("s3cret").request("/hello", {
        method: "POST",
        headers: { "x-amicode-gateway-secret": "s3cret" },
      })
      expect(ok.status).toBe(200)
    }),
  )

  it.live("secret set: the secret in a query param does NOT authorize", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("s3cret").request("/hello?x-amicode-gateway-secret=s3cret")
      expect(response.status).toBe(401)
    }),
  )

  it.live("secret UNSET: today's open behavior (compat window)", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp().request("/hello")
      expect(response.status).toBe(200)
    }),
  )

  it.live("empty-string secret is treated as unset (safety valve)", () =>
    Effect.gen(function* () {
      const response = yield* gatewayApp("").request("/hello")
      expect(response.status).toBe(200)
    }),
  )
})

describe("SSE-404-JSON guard (#1760 P1: SPA fallback never answers SSE)", () => {
  it.live("Accept: text/event-stream on an unrouted path is 404 JSON, never the SPA index", () =>
    Effect.gen(function* () {
      const response = yield* uiApp().request("/event", {
        headers: { accept: "text/event-stream" },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = yield* Effect.promise(() => response.text())
      expect(body.startsWith("<")).toBe(false)
      expect(JSON.parse(body).error).toBeTruthy()
    }),
  )

  it.live("a plain document GET still serves the UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp().request("/")
      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.text())
      expect(body).toBe("<html>the app</html>")
    }),
  )

  it.live("the guard fires with the secret armed too (an authenticated SSE miss still gets 404 JSON)", () =>
    Effect.gen(function* () {
      const response = yield* uiApp("s3cret").request("/event", {
        headers: { accept: "text/event-stream", "x-amicode-gateway-secret": "s3cret" },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
    }),
  )

  it.live("with the secret armed and no header, the 401 wins (auth before routing answers)", () =>
    Effect.gen(function* () {
      const response = yield* uiApp("s3cret").request("/event", {
        headers: { accept: "text/event-stream" },
      })
      expect(response.status).toBe(401)
    }),
  )
})

describe("full route tree wiring (#1760 P1)", () => {
  // GET /doc is the self-contained probe: a real route in the assembled tree
  // (authOnlyRouterLayer), no network, no config-directory context.
  it.live("the assembled engine enforces the secret on every route", () =>
    Effect.gen(function* () {
      const response = yield* fullApp({ AMICODE_ENGINE_SHARED_SECRET: "s3cret" }).request("/doc")
      expect(response.status).toBe(401)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = yield* Effect.promise(() => response.text())
      expect(body.startsWith("<")).toBe(false)

      const ok = yield* fullApp({ AMICODE_ENGINE_SHARED_SECRET: "s3cret" }).request("/doc", {
        headers: { "x-amicode-gateway-secret": "s3cret" },
      })
      expect(ok.status).toBe(200)
    }),
  )

  it.live("the assembled engine stays open when the env is unset", () =>
    Effect.gen(function* () {
      const response = yield* fullApp({}).request("/doc")
      expect(response.status).toBe(200)
    }),
  )
})
