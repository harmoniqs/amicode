import { describe, expect, test } from "bun:test"
import { adoptHiddenProject, hiddenProjectWorktree } from "./amicode-hidden-project"

describe("amicode hidden-project boot param (amicode#203)", () => {
  test("unset by default", () => {
    expect(hiddenProjectWorktree()).toBeUndefined()
  })
  test("adopts the amicode_hide_project param; ignores an empty/absent one", () => {
    adoptHiddenProject("?colorScheme=dark") // no param → stays unset
    expect(hiddenProjectWorktree()).toBeUndefined()
    adoptHiddenProject("?amicode_hide_project=%2Fusers%2Fk%2F.scaffold&auth_token=x")
    expect(hiddenProjectWorktree()).toBe("/users/k/.scaffold")
  })
})
