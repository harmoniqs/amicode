import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { writeRegistration } from "../src/registration.ts"
import { cleanup, makeSandbox, walkFiles } from "./helpers.ts"

afterAll(cleanup)

const info = (id = crypto.randomUUID()) => ({ id, version: "0.1.0", url: "http://127.0.0.1:52000", pid: process.pid })

describe("host registration file", () => {
  test("is written atomically with mode 0600, exactly the documented keys, and never a password", () => {
    const sb = makeSandbox("reg")
    const registration = writeRegistration(sb.registration, info())
    const stat = fs.statSync(sb.registration)
    expect(stat.mode & 0o777).toBe(0o600)
    const body = JSON.parse(fs.readFileSync(sb.registration, "utf8"))
    expect(Object.keys(body).sort()).toEqual(["id", "pid", "startedAt", "url", "version"])
    expect(typeof body.startedAt).toBe("number")
    expect(fs.readFileSync(sb.registration, "utf8")).not.toContain(sb.password)
    // no temp file left behind
    expect(fs.readdirSync(path.dirname(sb.registration))).toEqual(["host.json"])
    registration.remove()
  })
  test("remove deletes the file it wrote, and only if it still owns it", () => {
    const sb = makeSandbox("reg")
    const first = writeRegistration(sb.registration, info("one"))
    first.remove()
    expect(fs.existsSync(sb.registration)).toBe(false)

    const mine = writeRegistration(sb.registration, info("mine"))
    // someone else replaces the file: we must not delete theirs
    fs.writeFileSync(sb.registration, JSON.stringify({ ...info("theirs"), startedAt: 1 }))
    mine.remove()
    expect(JSON.parse(fs.readFileSync(sb.registration, "utf8")).id).toBe("theirs")
  })
  test("creates the parent directory", () => {
    const sb = makeSandbox("reg")
    const file = path.join(sb.root, "a", "b", "host.json")
    writeRegistration(file, info()).remove()
    expect(fs.existsSync(path.dirname(file))).toBe(true)
  })
  test("never creates, reads or modifies anything under .../opencode/service*.json", () => {
    const sb = makeSandbox("reg")
    writeRegistration(sb.registration, info()).remove()
    expect(walkFiles(sb.root).filter((file) => /\/opencode\/service[^/]*\.json$/.test(file))).toEqual([])
  })
})
