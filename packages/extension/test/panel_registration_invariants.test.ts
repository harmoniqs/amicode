import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  ScriptTarget,
  SyntaxKind,
  type CallExpression,
  type Node,
  type ObjectLiteralExpression,
} from "typescript";

/**
 * Panel-registration invariants (#1747).
 *
 * Enumerates every webview registration under src/ from the registration
 * source itself — the createWebviewPanel / registerWebviewViewProvider call
 * sites plus `.webview.options =` assignments — and pins the flags that must
 * hold uniformly across all of them. VS Code suspends any webview lacking
 * `retainContextWhenHidden: true` the moment it is hidden (the 7b658cc1
 * sidebar failure: frozen SSE stream, "stuck thinking" panel), so the flag is
 * an invariant of every registration, not a per-panel nicety.
 *
 * Enumerate, never hand-copy (the B1 #1744 discipline): there is no central
 * registry or factory — the seam the code actually shares is the registration
 * call grammar, read through the TypeScript AST (the same parser that
 * typechecks this package; a text-level scan is not honest enough here — it
 * derails on regex literals and template strings, and a commented-out flag
 * would pass it). The walker visits every file under src/, so a panel
 * registered ANYWHERE under src/ is covered the moment it appears: the golden
 * snapshot goes red until it is acknowledged, and the flag invariant below
 * already applies to it. Coverage comes from the enumeration; the snapshot
 * only pins that the enumeration is alive (a walker that silently finds
 * nothing cannot pass it).
 *
 * Exemptions are explicit and recorded at the registration site, never
 * silent: a panel that genuinely wants suspension states its reason as a
 * `retain-exempt: <reason>` comment inside its options object.
 */

const SRC_DIR = resolve(__dirname, "..", "src");

type RegistrationKind = "createWebviewPanel" | "registerWebviewViewProvider" | "webview.options";

type PanelRegistration = {
  kind: RegistrationKind;
  /** createWebviewPanel viewType / registerWebviewViewProvider viewId; "" for `.webview.options` assignments (identity = the file). */
  viewType: string;
  file: string;
  /** Raw text of the registration options object — comments included, which is where an exemption reason lives. */
  options: string;
  /** retainContextWhenHidden: true present as code (an AST property, not a mentioned-in-comment match). */
  flagged: boolean;
};

// ── Enumeration ───────────────────────────────────────────────────────────────

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.mts")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".mts") ? [path] : [];
  });
}

/** `retainContextWhenHidden: true` as a property of the object — the true
 *  keyword, never a string or comment. */
function hasRetainFlag(options: ObjectLiteralExpression): boolean {
  return options.properties.some((p) => {
    if (!isPropertyAssignment(p) || p.name.getText() !== "retainContextWhenHidden") return false;
    return p.initializer.kind === SyntaxKind.TrueKeyword;
  });
}

/** The flag may sit directly on the options object (createWebviewPanel,
 *  `.webview.options`) or one level under `webviewOptions` (the
 *  registerWebviewViewProvider shape). */
function retainsContextWhenHidden(options: ObjectLiteralExpression): boolean {
  if (hasRetainFlag(options)) return true;
  return options.properties.some((p) => {
    if (!isPropertyAssignment(p) || p.name.getText() !== "webviewOptions") return false;
    return isObjectLiteralExpression(p.initializer) && hasRetainFlag(p.initializer);
  });
}

function collectRegistrations(src: string, file: string): PanelRegistration[] {
  const sourceFile = createSourceFile(file, src, ScriptTarget.Latest, true);
  const out: PanelRegistration[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const callee = isPropertyAccessExpression(node.expression)
        ? node.expression.name.getText()
        : node.expression.getText();
      if (callee === "createWebviewPanel" || callee === "registerWebviewViewProvider") {
        const optionsNode = node.arguments[node.arguments.length - 1];
        // A non-literal options argument (a variable, a spread) cannot carry
        // a visible flag and reads as UNFLAGGED — flags live at the
        // registration site, not in a distant constant.
        out.push({
          kind: callee,
          viewType: node.arguments.length > 0 && isStringLiteral(node.arguments[0]) ? node.arguments[0].text : "",
          file,
          options: optionsNode === undefined ? "" : optionsNode.getText(sourceFile),
          flagged: optionsNode !== undefined && isObjectLiteralExpression(optionsNode) && retainsContextWhenHidden(optionsNode),
        });
      }
    }
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile).endsWith(".webview.options") &&
      isObjectLiteralExpression(node.right)
    ) {
      out.push({
        kind: "webview.options",
        viewType: "",
        file,
        options: node.right.getText(sourceFile),
        flagged: hasRetainFlag(node.right),
      });
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function enumerateSrc(): PanelRegistration[] {
  return srcFiles(SRC_DIR).flatMap((path) =>
    collectRegistrations(readFileSync(path, "utf8"), relative(SRC_DIR, path)),
  );
}

// ── The invariant set ─────────────────────────────────────────────────────────
// Flags that must hold on EVERY enumerated registration. A future uniform flag
// is one entry here — the enumeration applies it to all panels automatically;
// exemptions stay per-registration and explicit at the registration site.

/** The exemption's stated reason: the rest of the `retain-exempt:` line in
 *  the options object's comments. A marker with no reason is NOT an
 *  exemption — "explicit and recorded, never silent" means the panel says
 *  why, at the registration site. */
function exemptionReason(options: string): string | null {
  const match = options.match(/retain-exempt:[ \t]*([^\n]+)/);
  const reason = match?.[1].replace(/\*\/\s*$/, "").trim();
  return reason && reason.length > 0 ? reason : null;
}

function statusOf(reg: PanelRegistration): "retained" | "exempt" | "UNFLAGGED" {
  if (reg.flagged) return "retained";
  if (exemptionReason(reg.options) !== null) return "exempt";
  return "UNFLAGGED";
}

const PANEL_INVARIANTS = [
  {
    name: "retainContextWhenHidden: true — VS Code suspends any webview without it the moment it is hidden (7b658cc1)",
    violation: (reg: PanelRegistration): string | null =>
      statusOf(reg) === "UNFLAGGED"
        ? "registered without retainContextWhenHidden: true and without an explicit retain-exempt reason"
        : null,
  },
];

function invariantViolations(regs: PanelRegistration[]): Array<{ reg: PanelRegistration; failed: string[] }> {
  return regs
    .map((reg) => ({ reg, failed: PANEL_INVARIANTS.map((inv) => inv.violation(reg)).filter((v) => v !== null) }))
    .filter((r) => r.failed.length > 0);
}

// ── Golden snapshot ───────────────────────────────────────────────────────────
// NOT the coverage list: the invariants run on whatever enumerates out of src/,
// so a new panel fails red here until acknowledged AND fails the flag
// invariant if it lacks the flag (or an exemption). This snapshot only pins
// that the enumeration is alive and complete.

const GOLDEN_REGISTRATIONS = [
  { kind: "registerWebviewViewProvider", viewType: "amicode.workspace", file: "extension.ts", status: "retained" },
  { kind: "createWebviewPanel", viewType: "amicode.chat", file: "chat_panel.ts", status: "retained" },
  { kind: "createWebviewPanel", viewType: "amicode.deck", file: "deck_panel.ts", status: "retained" },
  { kind: "createWebviewPanel", viewType: "amicode.fleet", file: "fleet_panel.ts", status: "exempt" },
  { kind: "createWebviewPanel", viewType: "amicode.onboarding", file: "onboarding_panel.ts", status: "exempt" },
  { kind: "webview.options", viewType: "", file: "sidebar_view.ts", status: "retained" },
];

const snapshotKey = (r: { file: string; kind: string; viewType: string }) => `${r.file}/${r.kind}/${r.viewType}`;

function snapshot(regs: PanelRegistration[]) {
  return regs
    .map((r) => ({ kind: r.kind, viewType: r.viewType, file: r.file, status: statusOf(r) }))
    .sort((a, b) => snapshotKey(a).localeCompare(snapshotKey(b)));
}

describe("panel-registration invariants (#1747)", () => {
  it("golden: enumerates the webview registration set from the registration source itself", () => {
    expect(snapshot(enumerateSrc())).toEqual(
      [...GOLDEN_REGISTRATIONS].sort((a, b) => snapshotKey(a).localeCompare(snapshotKey(b))),
    );
  });

  it("every enumerated registration retains context when hidden or records an explicit exemption", () => {
    const failed = invariantViolations(enumerateSrc());
    expect(failed.map((f) => `${f.reg.file} [${f.reg.kind} ${f.reg.viewType}]: ${f.failed.join("; ")}`)).toEqual([]);
  });

  it("leak pin: retain-exempt with NO stated reason is still a violation — exemptions are never silent", () => {
    const synthetic = `vscode.window.createWebviewPanel("amicode.silent", "S", vscode.ViewColumn.One, {
      enableScripts: true,
      // retain-exempt:
    });`;
    const failed = invariantViolations(collectRegistrations(synthetic, "silent_fixture.ts"));
    expect(failed.map((f) => `${f.reg.viewType}: ${f.failed.join("; ")}`)).toEqual([
      "amicode.silent: registered without retainContextWhenHidden: true and without an explicit retain-exempt reason",
    ]);
  });

  it("leak pin: a panel registered WITHOUT the flag and WITHOUT an exemption fails red — the golden bites", () => {
    // The leak direction this guards is real, not hypothetical: the first run
    // of the golden caught exactly this in production code (fleet_panel.ts
    // and onboarding_panel.ts both registered unflagged). This fixture pins
    // it permanently: the NEXT panel registered without the flag fails red
    // at this boundary, not in front of the user.
    const synthetic = `const panel = vscode.window.createWebviewPanel(
      "amicode.synthetic",
      "Synthetic",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );`;
    const failed = invariantViolations(collectRegistrations(synthetic, "unflagged_fixture.ts"));
    expect(failed).toHaveLength(1);
    expect(failed[0].reg.viewType).toBe("amicode.synthetic");
    expect(failed[0].failed).toEqual([
      "registered without retainContextWhenHidden: true and without an explicit retain-exempt reason",
    ]);
  });

  it("leak pin: a properly flagged registration is not a violation — the detector is not a blanket flagger", () => {
    const synthetic = `const panel = vscode.window.createWebviewPanel("amicode.flagged", "F", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    vscode.window.registerWebviewViewProvider("amicode.flaggedview", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    });`;
    expect(invariantViolations(collectRegistrations(synthetic, "flagged_fixture.ts"))).toEqual([]);
  });
});
