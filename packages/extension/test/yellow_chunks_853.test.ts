// Issue #853 — the yellow-chunks port (fork amico/yellow-chunks-on-21 → the
// app overlay). Headless under vitest (the #848/#859/#862 pattern): the pure
// helpers the port added — the docket token builders (6dac9ce04) and the
// shell row detail (85d3eaf04) — plus CSS-grammar regression guards for the
// visual grammar the port establishes (the #349 deletion bug class: the slab,
// the docket slots, the yellow answer chip, the per-scheme prompt-bubble
// seating, the shell command anatomy).
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { contextDocket, editDocket, shellDocket, type DocketPart } from "../../app-bundle/overlay/packages/ui/src/amicode/docket"
import { shellRowDetail, SHELL_ROW_MAX } from "../../app-bundle/overlay/packages/ui/src/amicode/shell-row"

const overlay = (...p: string[]) => join(__dirname, "..", "..", "app-bundle", "overlay", ...p)

function part(tool: string, input: Record<string, unknown> = {}, status = "done", metadata: Record<string, unknown> = {}): DocketPart {
  return { tool, state: { status, input, metadata } }
}

function edit(filePath: string, additions = 0, deletions = 0): DocketPart {
  return part("edit", { filePath }, "done", { filediff: { additions, deletions } })
}

describe("editDocket (fork 6dac9ce04, ported)", () => {
  test("one token per unique file, ± summed across repeat edits", () => {
    const docket = editDocket([edit("/a/b/solve.jl", 5, 1), edit("/a/b/solve.jl", 7, 2), edit("/x/spec.toml", 4, 0)])
    expect(docket.more).toBe(0)
    expect(docket.tokens).toEqual([
      { kind: "file", name: "solve.jl", dir: "/a/b", additions: 12, deletions: 3 },
      { kind: "file", name: "spec.toml", dir: "/x", additions: 4, deletions: undefined },
    ])
  })

  test("caps at max and reports the rest", () => {
    const docket = editDocket(["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => edit(`/p/${f}`)), 2)
    expect(docket.tokens).toHaveLength(2)
    expect(docket.more).toBe(2)
  })

  test("pending parts without a path contribute nothing", () => {
    expect(editDocket([part("edit")])).toEqual({ tokens: [], more: 0 })
  })

  test("a file edited with zero recorded diff still appears, without ±", () => {
    const docket = editDocket([part("edit", { filePath: "/q/bare.jl" })])
    expect(docket.tokens).toEqual([{ kind: "file", name: "bare.jl", dir: "/q", additions: undefined, deletions: undefined }])
  })
})

describe("contextDocket (fork 6dac9ce04, ported)", () => {
  test("reads become file tokens, searches merge patterns, lists become dirs", () => {
    const parts = [
      part("read", { filePath: "/a/one.jl" }),
      part("grep", { pattern: "fidelity", path: "/a" }),
      part("grep", { pattern: "fidelity", path: "/a" }),
      part("list", { path: "/a/src" }),
    ]
    expect(contextDocket(parts)).toEqual({
      tokens: [
        { kind: "file", name: "one.jl" },
        { kind: "pattern", text: "fidelity", count: 2 },
        { kind: "dir", text: "/a/src" },
      ],
      more: 0,
    })
  })

  test("caps and counts the tail", () => {
    const docket = contextDocket(["x", "y", "z", "w"].map((p) => part("read", { filePath: `/${p}.jl` })), 2)
    expect(docket.tokens).toHaveLength(2)
    expect(docket.more).toBe(2)
  })
})

describe("shellDocket (fork 6dac9ce04, ported)", () => {
  test("counts commands and failures", () => {
    const parts = [part("bash"), part("bash"), part("bash", {}, "error")]
    expect(shellDocket(parts)).toEqual({ commands: 3, failed: 1 })
  })
})

describe("shellRowDetail (fork 85d3eaf04, ported)", () => {
  test("exit surfaces only when it isn't 0", () => {
    expect(shellRowDetail({ state: { metadata: { exit: 0 } } }).exit).toBeUndefined()
    expect(shellRowDetail({ state: { metadata: { exit: 64 } } }).exit).toBe(64)
  })

  test("duration comes from state.time when both ends exist", () => {
    expect(
      shellRowDetail({ state: { time: { start: 1000, end: 4250 }, metadata: {} } }).durationMs,
    ).toBe(3250)
    expect(shellRowDetail({ state: { time: { start: 1000 }, metadata: {} } }).durationMs).toBeUndefined()
  })

  test("output preview is the clamped first line", () => {
    const detail = shellRowDetail({ state: { metadata: { output: "line one\nline two" } } })
    expect(detail.preview).toBe("line one")
    expect(shellRowDetail({ state: { metadata: { output: "x".repeat(SHELL_ROW_MAX + 10) } } }).preview?.endsWith("…")).toBe(true)
  })

  test("a pending part yields an empty detail", () => {
    expect(shellRowDetail({})).toEqual({})
  })
})

describe("yellow-chunks CSS grammar (the #349 deletion bug class)", () => {
  const messageCss = () => readFileSync(overlay("packages", "session-ui", "src", "components", "message-part.css"), "utf8")
  const markdownCss = () => readFileSync(overlay("packages", "session-ui", "src", "components", "markdown.css"), "utf8")
  const polishCss = () => readFileSync(overlay("packages", "app", "src", "design-polish.css"), "utf8")

  test("the answer renders as the prompt bubble's chip (fork 8c91b45fa)", () => {
    const css = messageCss()
    expect(css).toMatch(/answer-text[^}]*--prompt-bubble-bg/s)
    expect(css).toMatch(/answer-text[^}]*margin-left:\s*auto/s)
  })

  test("the docket slots carry the collapsed rows' evidence (fork 6dac9ce04)", () => {
    const css = messageCss()
    expect(css).toContain('[data-slot="context-tool-group-docket"]')
    expect(css).toContain('[data-slot="docket-token"] .docket-file-icon')
    expect(css).toContain('[data-slot="docket-token"][data-kind="more"]')
    expect(css).toMatch(/docket-diff[^}]*data-sign="add"/s)
    expect(css).toContain('[data-slot="docket-failed"]')
  })

  test("the slab: fenced code leaves the prose-card grammar (fork 1bd3ae7d7)", () => {
    const css = markdownCss()
    expect(css).toContain("--markdown-slab-bg")
    expect(css).toMatch(/\[data-prose-fragment\] \[data-component="markdown-code"\][^}]*margin:\s*2px -14px/s)
    expect(css).toMatch(/\[data-prose-fragment\] \[data-component="markdown-code"\]::before[^}]*attr\(data-language\)/s)
    expect(css).toMatch(/\[data-prose-fragment\] \[data-component="markdown-code"\]\[data-code-kind="shell"\] \.shiki[^}]*background:\s*transparent/s)
  })

  test("the prompt bubble seats per scheme — yellow chip on light, dark box + full yellow border on dark (fork dc116cd6c + 99cb3f93d)", () => {
    const css = polishCss()
    expect(css).toContain("--prompt-bubble-edge")
    expect(css).toMatch(/\[data-color-scheme="dark"\] \{\s*--prompt-bubble-bg: var\(--v2-background-bg-layer-01\);\s*--prompt-bubble-ink: var\(--v2-text-text-base\);\s*--prompt-bubble-edge: var\(--accent\);/s)
  })

  test("the assistant fragments stay on the theme hairline in both schemes (fork 1e2e44b66 net)", () => {
    const css = polishCss()
    expect(css).toMatch(/\[data-prose-fragment\] \{[^}]*border: var\(--border-width\) solid var\(--v2-border-border-base\);/s)
    expect(css).not.toContain("--prose-fragment-edge")
  })

  test("the shell command anatomy slots exist (fork 85d3eaf04)", () => {
    const css = messageCss()
    for (const slot of ["cmd-dot", "cmd-prompt", "cmd-duration", "cmd-exit", "cmd-preview", "docket-row-file"]) {
      expect(css).toContain(`[data-slot="${slot}"]`)
    }
    expect(css).toMatch(/cmd-dot-pulse/)
  })

  test("the WAAPI merge note records the bubble-lock decision (fork 8c91b45fa)", () => {
    expect(polishCss()).toContain("WAAPI merge")
  })
})
