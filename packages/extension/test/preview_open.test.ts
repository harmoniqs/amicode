// #2130 — amicode_open_preview: the agent-side half of "open a file in the
// side-panel Preview". The tool validates and returns an AMICODE_PREVIEW
// sentinel; the app's card does the opening (ui/src/amicode/preview-open.ts
// parses the same line). Both transports execute the same function.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-preview-open-"));

import {
  PREVIEW_HTML_LIMIT,
  PREVIEW_SENTINEL_PREFIX,
  PREVIEW_TEXT_LIMIT,
  executePreviewOpen,
} from "../opencode-plugin/preview_open";

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");

const dir = mkdtempSync(join(tmpdir(), "preview-open-"));
const page = join(dir, "dash.html");
writeFileSync(page, "<h1>hi</h1>");

function sentinelOf(out: string) {
  const last = out.trimEnd().split("\n").pop() ?? "";
  if (!last.startsWith(PREVIEW_SENTINEL_PREFIX)) return undefined;
  return JSON.parse(last.slice(PREVIEW_SENTINEL_PREFIX.length));
}

describe("executePreviewOpen", () => {
  it("an existing absolute file returns the sentinel as the LAST line", () => {
    const out = executePreviewOpen({ path: page });
    expect(sentinelOf(out)).toEqual({ path: page, name: "dash.html", bytes: 11 });
    expect(out).not.toMatch(/Warning/);
  });

  it("accepts file:// URLs and normalizes the path", () => {
    expect(sentinelOf(executePreviewOpen({ path: `file://${dir}/./dash.html` }))?.path).toBe(page);
  });

  it("expands ~/", () => {
    const home = mkdtempSync(join(homedir(), ".amicode-preview-open-test-"));
    const f = join(home, "a.md");
    writeFileSync(f, "# a");
    const rel = "~/" + relative(homedir(), f);
    try {
      expect(sentinelOf(executePreviewOpen({ path: rel }))?.path).toBe(f);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses missing, relative, directory and empty paths with no sentinel", () => {
    for (const p of [join(dir, "nope.html"), "dash.html", dir, "", undefined]) {
      const out = executePreviewOpen({ path: p });
      expect(out, String(p)).toMatch(/^Not opened:/);
      expect(sentinelOf(out)).toBeUndefined();
    }
  });

  it("warns (but still opens) when a page is over the Preview's size limit", () => {
    const big = join(dir, "big.html");
    writeFileSync(big, "x".repeat(PREVIEW_HTML_LIMIT + 1));
    const out = executePreviewOpen({ path: big });
    expect(out).toMatch(/over the Preview's 16\.0 MB limit for a HTML page/);
    expect(sentinelOf(out)?.path).toBe(big);
  });

  it("an HTML page between the text and HTML limits gets no warning", () => {
    const mid = join(dir, "mid.html");
    writeFileSync(mid, "x".repeat(PREVIEW_TEXT_LIMIT + 1));
    expect(executePreviewOpen({ path: mid })).not.toMatch(/Warning/);
    const txt = join(dir, "mid.txt");
    writeFileSync(txt, "x".repeat(PREVIEW_TEXT_LIMIT + 1));
    expect(executePreviewOpen({ path: txt })).toMatch(/limit for a text file/);
  });

  it("images and PDFs are never size-warned", () => {
    const sub = join(dir, "plots");
    mkdirSync(sub);
    const png = join(sub, "p.png");
    writeFileSync(png, Buffer.alloc(PREVIEW_TEXT_LIMIT + 10));
    expect(executePreviewOpen({ path: png })).not.toMatch(/Warning/);
  });
});

describe("amicode_open_preview in both transports", () => {
  it("the core table and the plugin twin execute the same thing", async () => {
    const pack = (await PLUGIN.AmicodeTools({})) as {
      tool: Record<string, { execute: (a: unknown) => Promise<string> }>;
    };
    const viaPlugin = await pack.tool["amicode_open_preview"].execute({ path: page });
    const viaCore = await CORE.AMICODE_TOOLS["amicode_open_preview"].execute({ path: page }, {});
    expect(viaPlugin).toBe(viaCore);
    expect(sentinelOf(viaCore)?.path).toBe(page);
  });

  it("tells the agent to use it instead of an external browser", () => {
    expect(CORE.AMICODE_TOOLS["amicode_open_preview"].description).toMatch(/INSTEAD of/);
  });
});
