import { describe, expect, test } from "bun:test"
import { projectTypeStyle, groupProjectsByType } from "./project-type-helpers"

describe("projectTypeStyle", () => {
  test("research → flask yellow, dev → code-brackets blue", () => {
    expect(projectTypeStyle("research")).toEqual({ icon: "flask", variant: "yellow" })
    expect(projectTypeStyle("dev")).toEqual({ icon: "code-brackets", variant: "blue" })
  })
})

describe("groupProjectsByType", () => {
  test("returns sections when both types present", () => {
    const projects = [
      { name: "a", type: "research" as const },
      { name: "b", type: "dev" as const },
      { name: "c", type: "research" as const },
    ]
    const groups = groupProjectsByType(projects)
    expect(groups).toHaveLength(2)
    expect(groups[0].label).toBe("Research")
    expect(groups[0].projects.map((p) => p.name)).toEqual(["a", "c"])
    expect(groups[1].label).toBe("Development")
    expect(groups[1].projects.map((p) => p.name)).toEqual(["b"])
  })

  test("returns empty when only one type is present", () => {
    expect(groupProjectsByType([{ name: "a", type: "dev" as const }])).toEqual([])
    expect(groupProjectsByType([{ name: "a", type: "research" as const }])).toEqual([])
  })

  test("returns empty when no typed projects", () => {
    expect(groupProjectsByType([{ name: "a" }, { name: "b" }])).toEqual([])
  })
})
