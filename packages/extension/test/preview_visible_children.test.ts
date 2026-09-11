import { describe, expect, it } from "vitest";
import { resolvePreviewVisibleChildrenDirectory } from "../src/preview_visible_children";

describe("Preview visible-children boundary", () => {
  it("accepts a current workspace-project root and keeps the requested directory inside it", () => {
    expect(resolvePreviewVisibleChildrenDirectory("/workspace/project", "notes", ["/workspace/project"])).toEqual({
      ok: true,
      directory: "/workspace/project/notes",
    });
  });

  it("rejects unknown roots and traversal", () => {
    expect(resolvePreviewVisibleChildrenDirectory("/outside", "", ["/workspace/project"])).toEqual({ ok: false });
    expect(resolvePreviewVisibleChildrenDirectory("/workspace/project", "../secrets", ["/workspace/project"])).toEqual({ ok: false });
  });
});
