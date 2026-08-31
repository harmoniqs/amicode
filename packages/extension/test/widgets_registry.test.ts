// AMICODE (issue #678): the campaign-digest built-in widget — registration
// and route-contract pins. The widget's JS is a string-rendered module (the
// jump-back-in pattern), so behavioral assertions are string-level on the
// registry entry + the route bodies; the iframe itself is exercised by the
// runtime's own contract, not here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, widgetsResponse, widgetCodeResponse } from "../src/amicode_service/widgets";
import { manifestToml, widgetJs } from "../src/amicode_service/widgets_src/campaign-digest";

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("campaign-digest built-in widget (issue #678)", () => {
  let savedWidgetsDir: string | undefined;
  let userDir: string;

  beforeAll(() => {
    // Hermetic registry: point the user-widgets root at an empty temp dir so
    // host state (~/.amico/widgets) can't leak entries into the assertions.
    savedWidgetsDir = process.env.AMICODE_WIDGETS_DIR;
    userDir = mkdtempSync(join(tmpdir(), "amico-widgets-"));
    process.env.AMICODE_WIDGETS_DIR = userDir;
  });
  afterAll(() => {
    if (savedWidgetsDir === undefined) delete process.env.AMICODE_WIDGETS_DIR;
    else process.env.AMICODE_WIDGETS_DIR = savedWidgetsDir;
    rmSync(userDir, { recursive: true, force: true });
  });

  // AC1 — registration, manifest validity, default tile order
  it("registers as a built-in after jump-back-in, with a valid tile manifest", () => {
    const { widgets, warnings } = loadRegistry();
    const jump = widgets.findIndex((w) => w.manifest.id === "jump-back-in");
    const digest = widgets.findIndex((w) => w.manifest.id === "campaign-digest");
    expect(jump).toBeGreaterThanOrEqual(0);
    expect(digest).toBeGreaterThan(jump);
    const entry = widgets[digest];
    expect(entry.builtin).toBe(true);
    expect(entry.manifest.size).toBe("tile");
    expect(KEBAB.test(entry.manifest.id)).toBe(true);
    expect(warnings.some((w) => w.id === "campaign-digest")).toBe(false);
  });

  it("manifest TOML carries the digest identity (parses into the registry)", () => {
    expect(manifestToml).toContain('id = "campaign-digest"');
    expect(manifestToml).toContain('size = "tile"');
    expect(manifestToml).toMatch(/height = \d+/);
  });

  // AC2 — the route contract, string-level on the widget source
  it("fetches the campaigns list then the campaign detail for the picked slug", () => {
    expect(widgetJs).toContain("'/amicode/campaigns'");
    expect(widgetJs).toContain("'/amicode/campaign?slug='");
    expect(widgetJs).toContain("encodeURIComponent(");
  });

  it("picks the newest ACTIVE campaign with a newest-overall fallback", () => {
    expect(widgetJs).toContain("pickCampaign");
    expect(widgetJs).toContain("'active'"); // the ACTIVE status match
  });

  it("renders up to 3 verdict chips from the detail's verdict rows", () => {
    expect(widgetJs).toContain("MAX_VERDICT_CHIPS = 3");
    expect(widgetJs).toContain("verdicts");
  });

  it("renders the needs-you line from the blocked section", () => {
    expect(widgetJs).toContain("needs you");
    expect(widgetJs).toContain("nothing blocked");
  });

  it("degrades to the empty state when there are no campaigns", () => {
    expect(widgetJs).toContain("showEmpty");
    expect(widgetJs).toContain("el.innerHTML = ''");
  });

  // AC3 — fetch failure → empty state, never an error dump
  it("catches fetch failures into the empty state", () => {
    expect(widgetJs).toContain(".catch(");
    // the catch path and the no-campaign path share the same empty state
    expect(widgetJs).toContain("showEmpty");
  });

  // AC4 — click composes into chat with the slug
  it("clicks through to amico.prompt with the campaign slug", () => {
    expect(widgetJs).toContain("amico.prompt(");
    expect(widgetJs).toContain("'Open the campaign '");
  });

  // AC5 — esc discipline + theme tokens only
  it("escapes all interpolated HTML and themes via --amc-* custom properties only", () => {
    expect(widgetJs).toContain("esc(");
    expect(widgetJs).toContain("&amp;");
    expect(widgetJs).toContain("&lt;");
    expect(widgetJs).toContain("&gt;");
    expect(widgetJs).toContain("&quot;");
    expect(widgetJs).toContain("var(--amc-");
    expect(widgetJs).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no raw hex colors
    expect(widgetJs).not.toContain("rgb(");
    expect(widgetJs).not.toContain("localStorage"); // opaque origin — it throws
  });

  // AC6 — registry/content-hash machinery consistency
  it("hashes the entry stably across registry loads (idempotence)", () => {
    const a = loadRegistry().widgets.find((w) => w.manifest.id === "campaign-digest");
    const b = loadRegistry().widgets.find((w) => w.manifest.id === "campaign-digest");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a!.hash).toBe(b!.hash);
  });

  it("serves the widget through the /amicode/widgets + widget-code route bodies", () => {
    const list = JSON.parse(widgetsResponse());
    expect(list.ok).toBe(true);
    expect(list.widgets.map((w: any) => w.id)).toContain("campaign-digest");
    const code = JSON.parse(widgetCodeResponse("campaign-digest"));
    expect(code.ok).toBe(true);
    expect(code.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(code.code).toBe(widgetJs); // the served code IS the source string
  });
});
