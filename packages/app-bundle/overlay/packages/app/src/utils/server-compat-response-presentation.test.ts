import { expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

test("forwards response presentation through the V1 compatibility adapter", async () => {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "POST" && request.url.endsWith("/prompt_async")) return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          data: {
            admittedSeq: 1,
            id: "msg_1",
            sessionID: "ses_1",
            timeCreated: 1,
            type: "user",
            prompt: { text: "Explain the result", response_presentation: "concise" },
            delivery: "steer",
          },
        })
      }
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: Promise.resolve("v1"),
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })

  await api.session.prompt({
    sessionID: "ses_1",
    text: "Explain the result",
    response_presentation: "concise",
  })
  await api.session.command({
    sessionID: "ses_1",
    command: "review",
    arguments: "",
    response_presentation: "detailed",
  })

  expect(await requests[0]!.json()).toMatchObject({ response_presentation: "concise" })
  expect(await requests[1]!.json()).toMatchObject({ response_presentation: "detailed" })
})

test("routes response presentation through the V2 durable prompt contract", async () => {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      return Response.json({
        data: {
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          prompt: { text: "Explain the result", response_presentation: "concise" },
          delivery: "steer",
        },
      })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: Promise.resolve("v2"),
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })

  await api.session.prompt({
    sessionID: "ses_1",
    text: "Explain the result @src/index.ts",
    files: [
      { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 19, end: 32 } },
    ],
    agents: [{ name: "build", mention: { text: "@build", start: 0, end: 6 } }],
    response_presentation: "concise",
    delivery: "queue",
    resume: false,
  })

  expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/prompt")
  expect(await requests[0]!.json()).toEqual({
    prompt: {
      text: "Explain the result @src/index.ts",
      files: [
        {
          uri: "file:///repo/src/index.ts",
          name: "index.ts",
          source: { text: "@src/index.ts", start: 19, end: 32 },
        },
      ],
      agents: [{ name: "build", source: { text: "@build", start: 0, end: 6 } }],
      response_presentation: "concise",
    },
    delivery: "queue",
    resume: false,
  })
})
