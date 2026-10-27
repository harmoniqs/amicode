import { describe, expect, test } from "bun:test"
import { isPresent, parseFlatYaml, splitFrontmatter, wikilink } from "./preview-frontmatter"

const note = `---
type: experiment
date: 2026-10-25
session_id: null
spec_revision: 4
freeze_sha: 2973da208115906d92ad103ca7d66bf6b1ef8bab
tags: [experiment, prestissimo, sqp]
evidence: ["[[experiment-20261025-sqp-globalization-bakeoff]]"]
question: D-GLOB — outer globalization: a colon inside
provenance: "session (2026-10-24/25); raw logs /tmp/x.log"
---

# Title

Body text.
`

describe("splitFrontmatter", () => {
  test("splits the block off and keeps the body intact", () => {
    const { frontmatter, body } = splitFrontmatter(note)
    expect(body.startsWith("# Title")).toBe(true)
    expect(frontmatter?.kind).toBe("parsed")
  })

  test("parses the vault note shapes", () => {
    const fm = splitFrontmatter(note).frontmatter
    if (fm?.kind !== "parsed") throw new Error("not parsed")
    const get = (k: string) => fm.entries.find((e) => e.key === k)?.value
    expect(get("type")).toBe("experiment")
    expect(get("date")).toBe("2026-10-25")
    expect(get("session_id")).toBeNull()
    expect(get("spec_revision")).toBe(4)
    expect(get("freeze_sha")).toBe("2973da208115906d92ad103ca7d66bf6b1ef8bab")
    expect(get("tags")).toEqual(["experiment", "prestissimo", "sqp"])
    expect(get("evidence")).toEqual(["[[experiment-20261025-sqp-globalization-bakeoff]]"])
    expect(get("question")).toBe("D-GLOB — outer globalization: a colon inside")
    expect(get("provenance")).toBe("session (2026-10-24/25); raw logs /tmp/x.log")
  })

  test("no front matter, or an unterminated block, leaves the document untouched", () => {
    expect(splitFrontmatter("# Just a doc\n---\n")).toEqual({ body: "# Just a doc\n---\n" })
    expect(splitFrontmatter("---\ntype: x\nno close")).toEqual({ body: "---\ntype: x\nno close" })
  })

  test("a shape the parser won't guess at falls back to raw", () => {
    const fm = splitFrontmatter("---\nnested:\n  a: 1\n---\nbody").frontmatter
    expect(fm?.kind).toBe("raw")
  })
})

describe("parseFlatYaml", () => {
  test("block lists and block scalars", () => {
    expect(parseFlatYaml("hooks:\n  - altissimo\n  - solve\nnote: |\n  line one\n  line two")).toEqual([
      { key: "hooks", value: ["altissimo", "solve"] },
      { key: "note", value: "line one\nline two" },
    ])
  })

  test("comments and booleans", () => {
    expect(parseFlatYaml("draft: true # wip\nok: false")).toEqual([
      { key: "draft", value: true },
      { key: "ok", value: false },
    ])
  })
})

describe("helpers", () => {
  test("isPresent hides empty values", () => {
    expect([null, "", [], [null]].map(isPresent)).toEqual([false, false, false, false])
    expect(["x", 0, false, ["a"]].map(isPresent)).toEqual([true, true, true, true])
  })

  test("wikilink", () => {
    expect(wikilink("[[spec-1]]")).toEqual({ target: "spec-1", label: "spec-1" })
    expect(wikilink("[[spec-1|the spec]]")).toEqual({ target: "spec-1", label: "the spec" })
    expect(wikilink("plain")).toBeUndefined()
  })
})
