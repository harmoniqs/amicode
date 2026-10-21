// #1776 (ported, #1806 P1a) — the global bus stamps source-side: a random
// per-process epoch, one strictly increasing seq assigned once per event at
// emit, taps that observe events BEFORE any ordinary listener (so nested emits
// stay strictly ordered), and the mirror window that lets a sync copy share
// its source's sequence. An engine restart is a fresh epoch — the resync
// boundary the reset contract rides on.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"

const emit = (type: string, properties: Record<string, unknown> = {}) =>
  GlobalBus.emit("event", { directory: "/tmp/p1a-bus", payload: { type, properties } })

describe("global bus — source-side sequencing (#1776 port)", () => {
  test("stamps every emitted event with a strictly increasing seq under a random epoch-shaped token", () => {
    expect(GlobalBus.epoch).toMatch(/^[A-Za-z0-9_-]+$/)
    const base = GlobalBus.seq
    const seqs: number[] = []
    const untap = GlobalBus.tap((_event, seq) => seqs.push(seq))
    try {
      emit("test.seq.a")
      emit("test.seq.b")
      emit("test.seq.c")
    } finally {
      untap()
    }
    expect(seqs).toEqual([base + 1, base + 2, base + 3])
    expect(GlobalBus.seq).toBe(base + 3)
  })

  test("a pre-dispatch tap observes nested emits strictly after their outer event", () => {
    const observed: Array<{ type: string; seq: number }> = []
    const untap = GlobalBus.tap((event, seq) => observed.push({ type: event.payload.type, seq }))
    const listener = (event: GlobalEvent) => {
      if (event.payload.type === "test.outer") emit("test.inner")
    }
    GlobalBus.on("event", listener)
    try {
      emit("test.outer")
    } finally {
      GlobalBus.off("event", listener)
      untap()
    }
    // Strict sequence order at the tap even though the inner emit happened
    // inside a listener's handler: outer was sequenced and tapped first.
    expect(observed.map((entry) => entry.type)).toEqual(["test.outer", "test.inner"])
    expect(observed[1]!.seq).toBe(observed[0]!.seq + 1)
  })

  test("an ordinary listener never sees an event before its tap does", () => {
    const order: string[] = []
    const untap = GlobalBus.tap((event) => order.push(`tap:${event.payload.type}`))
    const listener = (event: GlobalEvent) => order.push(`listener:${event.payload.type}`)
    GlobalBus.on("event", listener)
    try {
      emit("test.precedence")
    } finally {
      GlobalBus.off("event", listener)
      untap()
    }
    expect(order).toEqual(["tap:test.precedence", "listener:test.precedence"])
  })

  test("a sync copy mirrors its source's seq within the window; past the window it takes a fresh one", () => {
    const seqOf = (type: string, id?: string) => {
      let seq: number | undefined
      const untap = GlobalBus.tap((event, s) => {
        if (event.payload.type === type) seq = s
      })
      try {
        GlobalBus.emit("event", {
          directory: "/tmp/p1a-bus",
          payload: id === undefined ? { type } : { id, type },
        })
      } finally {
        untap()
      }
      return seq!
    }
    const copyAfter = (id: string) =>
      GlobalBus.emit("event", {
        directory: "/tmp/p1a-bus",
        payload: { type: "sync", syncEvent: { id, type: "test.durable.1", seq: 1, aggregateID: "agg", data: {} } },
      })

    // within the window: the copy follows its source with nothing between
    const source = seqOf("test.durable", "evt_p1a_window")
    let mirrored: number | undefined
    const untapMirror = GlobalBus.tap((event, seq) => {
      if (event.payload.type === "sync") mirrored = seq
    })
    try {
      copyAfter("evt_p1a_window")
    } finally {
      untapMirror()
    }
    expect(mirrored).toBe(source)

    // past the window (MIRROR_WINDOW = 256 remembered source ids): the source
    // is forgotten, so the copy is sequenced as a frame of its own
    for (let i = 0; i < 256; i++) seqOf("test.filler", `evt_p1a_fill_${i}`)
    let fresh: number | undefined
    const untapFresh = GlobalBus.tap((event, seq) => {
      if (event.payload.type === "sync") fresh = seq
    })
    try {
      copyAfter("evt_p1a_window")
    } finally {
      untapFresh()
    }
    expect(fresh).not.toBe(source)
    expect(fresh!).toBeGreaterThan(source)
  })

  test("a fresh process gets a fresh epoch — an engine restart is a resync boundary", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'const { GlobalBus } = await import("./src/bus/global.ts"); console.log(GlobalBus.epoch)',
      ],
      cwd: path.join(import.meta.dir, "..", ".."),
    })
    expect(result.stderr.toString()).toBe("")
    const other = result.stdout.toString().trim()
    expect(other).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(other).not.toBe(GlobalBus.epoch)
  })
})
