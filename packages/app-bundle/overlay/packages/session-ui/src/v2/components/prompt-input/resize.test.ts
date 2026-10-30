import { describe, expect, test } from "bun:test"
import {
  COMPOSER_HEIGHT_KEY,
  COMPOSER_KEY_STEP,
  COMPOSER_MIN_HEIGHT,
  clampComposerHeight,
  composerMaxHeight,
  createComposerResizer,
  dragComposerHeight,
  readComposerHeight,
  writeComposerHeight,
  type ComposerStorage,
} from "./resize"

function memoryStorage(initial: Record<string, string> = {}): ComposerStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  }
}

const VIEWPORT = 1000

function make(storage?: ComposerStorage, rendered = 100) {
  const seen: Array<number | undefined> = []
  const resizer = createComposerResizer({
    measure: () => rendered,
    viewport: () => VIEWPORT,
    storage,
    onChange: (h) => seen.push(h),
  })
  return { resizer, seen }
}

describe("composer height math", () => {
  test("clamps between the minimum and a fraction of the viewport", () => {
    expect(composerMaxHeight(1000)).toBe(600)
    expect(clampComposerHeight(10, 1000)).toBe(COMPOSER_MIN_HEIGHT)
    expect(clampComposerHeight(5000, 1000)).toBe(600)
    expect(clampComposerHeight(300, 1000)).toBe(300)
  })

  test("a tiny viewport never pushes the max below the minimum", () => {
    expect(composerMaxHeight(50)).toBe(COMPOSER_MIN_HEIGHT)
    expect(clampComposerHeight(500, 50)).toBe(COMPOSER_MIN_HEIGHT)
  })

  test("dragging the top edge up grows, down shrinks", () => {
    expect(dragComposerHeight(100, 500, 400, VIEWPORT)).toBe(200)
    expect(dragComposerHeight(200, 400, 450, VIEWPORT)).toBe(150)
  })
})

describe("composer resizer", () => {
  test("a drag from the rendered height reports growing heights and stops at the cap", () => {
    const { resizer, seen } = make(undefined, 120)
    expect(resizer.height()).toBeUndefined()
    resizer.begin(500)
    resizer.move(450)
    expect(resizer.height()).toBe(170)
    resizer.move(-9999)
    expect(resizer.height()).toBe(600)
    resizer.end()
    expect(seen.at(-1)).toBe(600)
  })

  test("moves without a begin are ignored", () => {
    const { resizer, seen } = make()
    resizer.move(10)
    expect(resizer.height()).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("the height is persisted on release and restored by a fresh resizer", () => {
    const storage = memoryStorage()
    const first = make(storage, 100).resizer
    first.begin(500)
    first.move(380)
    expect(storage.data[COMPOSER_HEIGHT_KEY]).toBeUndefined()
    first.end()
    expect(storage.data[COMPOSER_HEIGHT_KEY]).toBe("220")

    const second = make(storage, 100).resizer
    expect(second.height()).toBe(220)
  })

  test("a later drag starts from the stored height, not the rendered one", () => {
    const { resizer } = make(memoryStorage({ [COMPOSER_HEIGHT_KEY]: "300" }), 100)
    resizer.begin(500)
    resizer.move(400)
    expect(resizer.height()).toBe(400)
  })

  test("a stored height larger than the current viewport allows is displayed clamped but kept in storage", () => {
    const storage = memoryStorage({ [COMPOSER_HEIGHT_KEY]: "900" })
    const { resizer } = make(storage)
    expect(resizer.height()).toBe(600)
    expect(storage.data[COMPOSER_HEIGHT_KEY]).toBe("900")
  })

  test("ArrowUp / ArrowDown on the handle resize in steps and persist; other keys are not handled", () => {
    const storage = memoryStorage()
    const { resizer } = make(storage, 100)
    expect(resizer.key("ArrowUp")).toBe(true)
    expect(resizer.height()).toBe(100 + COMPOSER_KEY_STEP)
    expect(storage.data[COMPOSER_HEIGHT_KEY]).toBe(String(100 + COMPOSER_KEY_STEP))
    expect(resizer.key("ArrowDown")).toBe(true)
    expect(resizer.height()).toBe(100)
    expect(resizer.key("Enter")).toBe(false)
  })

  test("keyboard shrink stops at the minimum", () => {
    const { resizer } = make(undefined, COMPOSER_MIN_HEIGHT)
    resizer.key("ArrowDown")
    expect(resizer.height()).toBe(COMPOSER_MIN_HEIGHT)
  })

  test("reset returns to the stock auto height and forgets the stored value", () => {
    const storage = memoryStorage({ [COMPOSER_HEIGHT_KEY]: "300" })
    const { resizer, seen } = make(storage)
    resizer.reset()
    expect(resizer.height()).toBeUndefined()
    expect(storage.data[COMPOSER_HEIGHT_KEY]).toBeUndefined()
    expect(seen.at(-1)).toBeUndefined()
  })
})

describe("composer height storage", () => {
  test("ignores missing, non-numeric, and non-positive values", () => {
    expect(readComposerHeight(undefined)).toBeUndefined()
    expect(readComposerHeight(memoryStorage())).toBeUndefined()
    expect(readComposerHeight(memoryStorage({ [COMPOSER_HEIGHT_KEY]: "banana" }))).toBeUndefined()
    expect(readComposerHeight(memoryStorage({ [COMPOSER_HEIGHT_KEY]: "-5" }))).toBeUndefined()
    expect(readComposerHeight(memoryStorage({ [COMPOSER_HEIGHT_KEY]: "0" }))).toBeUndefined()
  })

  test("a throwing storage (private mode / quota) never breaks resizing", () => {
    const boom: ComposerStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("full")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    }
    expect(readComposerHeight(boom)).toBeUndefined()
    expect(() => writeComposerHeight(boom, 200)).not.toThrow()
    const { resizer } = make(boom, 100)
    resizer.begin(500)
    resizer.move(400)
    resizer.end()
    expect(resizer.height()).toBe(200)
  })
})
