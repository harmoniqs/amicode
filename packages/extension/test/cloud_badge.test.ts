import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The cloud badge is the surface that answers "am I running on the tier I'm
// paying for?". Two things have to hold for it to be worth having: it must obey
// the brand's fill rule (a gold INK is illegible on light themes — brand.css),
// and it must survive a panel reopen like every other pane message, or it
// silently disappears mid-solve.

const PILL = readFileSync(join(__dirname, "..", "media", "ui", "atoms", "pill.ts"), "utf8");
const VIEW = readFileSync(join(__dirname, "..", "media", "ui", "views", "inspector.ts"), "utf8");
const HOST = readFileSync(join(__dirname, "..", "src", "run_inspector.ts"), "utf8");

describe("cloud badge obeys the brand rule: yellow is a FILL, never an ink", () => {
  it("the lemon is the background and the label is on-accent, never accent-coloured text", () => {
    const rule = /\.pill\.cloud\s*\{([^}]*)\}/.exec(PILL)?.[1] ?? "";
    expect(rule).toContain("background: var(--color-accent-fill)");
    expect(rule).toContain("color: var(--color-on-accent)");
    // the failure this prevents: `color: var(--color-accent*)` — 1.1:1 on white
    expect(rule).not.toMatch(/color:\s*var\(--color-accent(-ink|-fill)?\)/);
  });

  it("the edge is the theme-solved hairline, so the badge bounds itself on light themes", () => {
    expect(/\.pill\.cloud\s*\{[^}]*\}/.exec(PILL)?.[0] ?? "").toContain("--color-accent-edge");
  });

  it("the cloud glyph cannot be erased by a caller passing dot:false", () => {
    // Equal specificity (.pill.no-dot::before vs .pill.cloud::before), so source
    // order decides — cloud must come last.
    const noDot = PILL.indexOf(".pill.no-dot::before");
    const cloud = PILL.indexOf(".pill.cloud::before");
    expect(noDot).toBeGreaterThan(-1);
    expect(cloud).toBeGreaterThan(noDot);
    expect(PILL).toMatch(/\.pill\.cloud::before\s*\{[^}]*content:\s*"☁"/);
  });
});

describe("cloud badge appears only when it means something", () => {
  it("the view hides it by default and reveals it only on cloud === true", () => {
    expect(VIEW).toMatch(/location\.el\.hidden = true/); // default: absent
    expect(VIEW).toMatch(/case "location":/);
    // strictly true — an absent/garbled flag must not light up a paid-tier badge
    expect(VIEW).toMatch(/location\.el\.hidden = msg\.cloud !== true/);
  });

  it("the host buffers it per pane, so reopening the panel keeps the badge", () => {
    // Every other pane message is replayed in replayPane; a badge that only ever
    // posted live would vanish the moment the user closed and reopened the view.
    expect(HOST).toMatch(/setCloudRun\(runId: string\)/);
    expect(HOST).toMatch(/paneFor\(runId\)\.cloud = true/);
    const replay = /private replayPane\([\s\S]*?\n  \}/.exec(HOST)?.[0] ?? "";
    expect(replay).toMatch(/p\.cloud.*type: "location".*cloud: true/s);
  });
});
