import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

async function write(directory: string, target: string, content: string) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${FilePaths.write}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": directory,
      },
      body: JSON.stringify({ path: target, content }),
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file.write human workspace gate (#1454 W5)", () => {
  test("rejects an outside absolute HTTP write before the permissive handler and leaves no file", async () => {
    await using tmp = await tmpdir({ git: true })
    const outside = path.join(tmp.path, "..", `outside-${Date.now()}`, "blocked.txt")

    const response = await write(tmp.path, outside, "must not persist")

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      _tag: "ForbiddenError",
      message: "File write path must remain inside the workspace",
    })
    expect(await Bun.file(outside).exists()).toBe(false)
  })

  test("passes a relative write through the cached-body middleware to the unchanged handler", async () => {
    await using tmp = await tmpdir({ git: true })

    const response = await write(tmp.path, "nested/allowed.txt", "relative content")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await Bun.file(path.join(tmp.path, "nested/allowed.txt")).text()).toBe("relative content")
  })

  test("passes an absolute path inside the workspace through to the unchanged handler", async () => {
    await using tmp = await tmpdir({ git: true })
    const inside = path.join(tmp.path, "nested", "absolute-allowed.txt")

    const response = await write(tmp.path, inside, "absolute inside content")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await Bun.file(inside).text()).toBe("absolute inside content")
  })
})
