import { describe, expect, test } from "bun:test"
import { skillBody } from "./message-part-skill"

// Wrapper shape produced by both skill tool implementations
// (packages/opencode/src/tool/skill.ts and packages/core/src/tool/skill.ts).
const OUTPUT = [
  '<skill_content name="atoms">',
  "# Skill: atoms",
  "",
  "## Rydberg conventions",
  "",
  "Use the 3-level model: $|0\\rangle$ dark, $|1\\rangle \\leftrightarrow |r\\rangle$ driven.",
  "",
  "Base directory for this skill: file:///home/u/.amico/skills/atoms",
  "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
  "Note: file list is sampled.",
  "",
  "<skill_files>",
  "<file>/home/u/.amico/skills/atoms/reference/blockade.md</file>",
  "</skill_files>",
  "</skill_content>",
].join("\n")

describe("skillBody", () => {
  test("returns empty string for undefined or empty output", () => {
    expect(skillBody(undefined)).toBe("")
    expect(skillBody("")).toBe("")
  })

  test("strips the transport wrapper and plumbing, keeps the instructions", () => {
    const body = skillBody(OUTPUT)
    expect(body).toContain("## Rydberg conventions")
    expect(body).toContain("3-level model")
    expect(body).not.toContain("<skill_content")
    expect(body).not.toContain("</skill_content>")
    expect(body).not.toContain("<skill_files>")
    expect(body).not.toContain("blockade.md")
    expect(body).not.toContain("Base directory")
    expect(body).not.toContain("Relative paths")
    expect(body).not.toContain("file list is sampled")
  })

  test("drops the '# Skill: name' heading (the chip already shows the name)", () => {
    expect(skillBody(OUTPUT)).not.toContain("# Skill: atoms")
  })

  test("keeps content lines that merely mention skill files mid-text", () => {
    const out = '<skill_content name="x">\nSee the skill_files note above for context.\n</skill_content>'
    expect(skillBody(out)).toBe("See the skill_files note above for context.")
  })

  test("passes through plain text without wrapper untouched (trimmed)", () => {
    expect(skillBody("  just some output  ")).toBe("just some output")
  })
})
