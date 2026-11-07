// amicode#1987 (#1979 S4): favorites persistence — the pure seam behind
// models.tsx's `favorite` (the persisted `user[]` entry's `favorite` flag).
import { describe, expect, test } from "bun:test"
import { favoritesOf, isFavorite, toggleFavorite, type UserModelEntry } from "./models-favorites"

const a = { providerID: "a", modelID: "x" }
const b = { providerID: "b", modelID: "y" }

describe("models favorites", () => {
  test("toggle on adds a favorite (newest first) without inventing a visibility", () => {
    const one = toggleFavorite([], a)
    expect(one).toEqual([{ ...a, favorite: true }])
    const two = toggleFavorite(one, b)
    expect(favoritesOf(two)).toEqual([b, a])
  })

  test("toggle on an existing visibility entry keeps its visibility", () => {
    const users: UserModelEntry[] = [{ ...a, visibility: "hide" }, { ...b, visibility: "show" }]
    const next = toggleFavorite(users, b)
    expect(next[0]).toEqual({ ...b, visibility: "show", favorite: true })
    expect(next).toContainEqual({ ...a, visibility: "hide" })
    expect(favoritesOf(next)).toEqual([b])
  })

  test("toggle off clears the flag, keeps the entry's visibility, round-trips", () => {
    const users: UserModelEntry[] = [{ ...a, visibility: "show", favorite: true }]
    const off = toggleFavorite(users, a)
    expect(off).toEqual([{ ...a, visibility: "show", favorite: false }])
    expect(isFavorite(off, a)).toBe(false)
    expect(isFavorite(toggleFavorite(off, a), a)).toBe(true)
  })

  test("pre-#1987 persisted entries (no favorite key) read as not-favorite", () => {
    const users: UserModelEntry[] = [{ ...a, visibility: "show" }]
    expect(favoritesOf(users)).toEqual([])
    expect(isFavorite(users, a)).toBe(false)
  })

  test("the input array is never mutated (store-safe)", () => {
    const users: UserModelEntry[] = [{ ...a, visibility: "show" }]
    const snapshot = structuredClone(users)
    toggleFavorite(users, a)
    expect(users).toEqual(snapshot)
  })
})
