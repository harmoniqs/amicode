import { describe, expect, test } from "bun:test"
import { getCommonAncestor, disambiguateFilenames, sortPathsByFilename } from "./file-list-model"

describe("getCommonAncestor", () => {
  test("returns the longest shared directory prefix", () => {
    expect(getCommonAncestor(["packages/app/src/foo.tsx", "packages/app/src/bar.tsx"])).toBe("packages/app/src")
  })

  test("returns partial shared prefix across different subdirectories", () => {
    expect(getCommonAncestor(["packages/app/src/foo.tsx", "packages/lib/utils.ts"])).toBe("packages")
  })

  test("returns empty string when paths diverge at root", () => {
    expect(getCommonAncestor(["src/a.ts", "test/b.ts"])).toBe("")
  })

  test("returns the directory for a single file", () => {
    expect(getCommonAncestor(["packages/app/src/foo.tsx"])).toBe("packages/app/src")
  })

  test("returns empty string for empty input", () => {
    expect(getCommonAncestor([])).toBe("")
  })

  test("returns empty string for files at root level", () => {
    expect(getCommonAncestor(["README.md", "package.json"])).toBe("")
  })

  test("does not treat partial directory names as shared", () => {
    expect(getCommonAncestor(["src-old/a.ts", "src-new/b.ts"])).toBe("")
  })
})

describe("sortPathsByFilename", () => {
  test("sorts paths alphabetically by basename, case-insensitive", () => {
    const paths = ["src/Zebra.ts", "lib/alpha.ts", "test/Beta.ts"]
    expect(sortPathsByFilename(paths)).toEqual(["lib/alpha.ts", "test/Beta.ts", "src/Zebra.ts"])
  })

  test("preserves original paths, only reorders", () => {
    const paths = ["deep/nested/z.ts", "shallow/a.ts"]
    expect(sortPathsByFilename(paths)).toEqual(["shallow/a.ts", "deep/nested/z.ts"])
  })
})

describe("disambiguateFilenames", () => {
  test("returns bare filenames when all basenames are unique", () => {
    const result = disambiguateFilenames(["src/foo.ts", "lib/bar.ts", "test/baz.ts"])
    expect(result).toEqual([
      { path: "src/foo.ts", label: "foo.ts" },
      { path: "lib/bar.ts", label: "bar.ts" },
      { path: "test/baz.ts", label: "baz.ts" },
    ])
  })

  test("appends minimum parent directory for duplicate basenames", () => {
    const result = disambiguateFilenames(["src/components/index.ts", "src/utils/index.ts"])
    expect(result).toEqual([
      { path: "src/components/index.ts", label: "index.ts", disambiguator: "components" },
      { path: "src/utils/index.ts", label: "index.ts", disambiguator: "utils" },
    ])
  })

  test("uses deeper parent when immediate parents are also the same", () => {
    const result = disambiguateFilenames([
      "src/components/auth/index.ts",
      "src/components/profile/index.ts",
    ])
    expect(result).toEqual([
      { path: "src/components/auth/index.ts", label: "index.ts", disambiguator: "auth" },
      { path: "src/components/profile/index.ts", label: "index.ts", disambiguator: "profile" },
    ])
  })

  test("handles three-way duplicates with different parent depths", () => {
    const result = disambiguateFilenames([
      "a/shared/index.ts",
      "b/shared/index.ts",
      "c/other/index.ts",
    ])
    expect(result).toEqual([
      { path: "a/shared/index.ts", label: "index.ts", disambiguator: "a/shared" },
      { path: "b/shared/index.ts", label: "index.ts", disambiguator: "b/shared" },
      { path: "c/other/index.ts", label: "index.ts", disambiguator: "other" },
    ])
  })

  test("does not disambiguate unique filenames even when directories overlap", () => {
    const result = disambiguateFilenames(["src/index.ts", "src/main.ts"])
    expect(result).toEqual([
      { path: "src/index.ts", label: "index.ts" },
      { path: "src/main.ts", label: "main.ts" },
    ])
  })
})

describe("edge cases per AC", () => {
  test("single file: ancestor is its directory, disambiguation is trivial", () => {
    expect(getCommonAncestor(["packages/app/src/foo.tsx"])).toBe("packages/app/src")
    expect(disambiguateFilenames(["packages/app/src/foo.tsx"])).toEqual([
      { path: "packages/app/src/foo.tsx", label: "foo.tsx" },
    ])
  })

  test("all files in same directory: ancestor equals that directory", () => {
    const paths = ["src/components/a.tsx", "src/components/b.tsx", "src/components/c.tsx"]
    expect(getCommonAncestor(paths)).toBe("src/components")
    expect(sortPathsByFilename(paths)).toEqual([
      "src/components/a.tsx",
      "src/components/b.tsx",
      "src/components/c.tsx",
    ])
  })

  test("no shared prefix: ancestor is empty, tree roots at project root", () => {
    const paths = ["src/a.ts", "test/b.ts", "docs/c.md"]
    expect(getCommonAncestor(paths)).toBe("")
  })
})
