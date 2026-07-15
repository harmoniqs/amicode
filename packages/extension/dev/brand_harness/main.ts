// Brand accent dev harness — renders the real webview components against
// stubbed VS Code theme vars so the light/dark brand treatment can be eyeballed
// without a live run. NOT shipped in the VSIX (dev/ is excluded; see
// .vscodeignore). Run: `pnpm run dev:brand`.
//
// The solver (applyBrandAccent) reads --vscode-editor-background +
// --vscode-foreground from index.html and sets --color-accent-{fill,edge,ink}
// at :root; toggling .dark on <body> mutates an attribute, so its
// MutationObserver re-solves — the components react exactly as in the webview.

import { applyBrandAccent, solveBrandAccent } from "../../media/ui/brand_accent";
import { metric } from "../../media/ui/components/metric";
import { button } from "../../media/ui/atoms/button";
import { sparkline } from "../../media/ui/components/sparkline";
import { catalogcard, type CatalogEntry } from "../../media/ui/components/catalogcard";

// --- brand swatch: fill + edge + on-accent, straight from the tokens
function swatch(label: string): HTMLElement {
  const d = document.createElement("div");
  d.textContent = label;
  d.style.cssText =
    "display:inline-flex;align-items:center;padding:7px 14px;border-radius:6px;" +
    "font-weight:600;font-size:14px;background:var(--color-accent-fill);" +
    "color:var(--color-on-accent);border:var(--border-width) solid var(--color-accent-edge);";
  return d;
}
const swatches = document.getElementById("swatches")!;
swatches.append(swatch("Solve complete"), swatch("CZ · 0.9994"), swatch("Promoted"));

// --- metrics: the flagged hero, a pending hero, and neutral (catalog-style)
const metricsHost = document.getElementById("metrics")!;
const heroFlag = metric("fidelity", { variant: "hero", flag: true });
heroFlag.value("0.9994");
const heroPending = metric("fidelity", { variant: "hero", flag: true }); // stays "–": no flag until it lands
const heroNeutral = metric("gate time", { variant: "hero" }); // catalog-style hero: no flag
heroNeutral.value("20 ns");
const small = metric("objective", { variant: "small" });
small.value("3.2e-4");
metricsHost.append(heroFlag.el, heroPending.el, heroNeutral.el, small.el);

// --- buttons (hover states are the point)
const buttonsHost = document.getElementById("buttons")!;
buttonsHost.append(
  button("■ Stop", () => {}).el,
  button("↓ Save pulse", () => {}).el,
  button("↗ Open run dir", () => {}).el,
);

// --- sparkline: a converging (descending) objective trace
const sparkHost = document.getElementById("sparkline")!;
const spark = sparkline(60);
sparkHost.append(spark.el);
for (let i = 0; i < 60; i++) spark.update(10 ** (1 - (i / 60) * 4) * (1 + 0.15 * Math.sin(i)));

// --- catalog card: fidelity + gate-time heroes (neutral) + proposed dashed metrics
const entry: CatalogEntry = {
  schema_version: "1",
  run_id: "run-demo-0715",
  lab_id: "lab-demo",
  fidelity: 0.99942,
  pulse_path: "catalog/pulses/transmon/cz.jld2",
  gate: "CZ",
  created_at: "2026-07-15",
  params: { system: "transmon", T: 20 },
  proposed: { tags: ["demo"], iterations: 320, wall_seconds: 45, system_name: "Demo transmon" },
};
document.getElementById("catalog")!.append(catalogcard(entry, { onAction: () => {} }).el);

// --- boot the solver + wire the theme toggle
applyBrandAccent();
const nowLabel = document.getElementById("now")!;
const refresh = (): void => {
  const cs = getComputedStyle(document.body);
  const r = solveBrandAccent(
    cs.getPropertyValue("--vscode-editor-background"),
    cs.getPropertyValue("--vscode-foreground"),
  );
  nowLabel.textContent = `${r.isLight ? "LIGHT" : "DARK"} · fill ${r.fill} · edge ${r.edge} · ink ${r.ink}`;
  document.getElementById("swatch-cap")!.textContent = r.isLight
    ? "light: true lemon fill, 1px dark hairline edge, black text"
    : "dark: true lemon fill, no edge (it separates itself), black text";
};
refresh();
document.getElementById("theme")!.addEventListener("click", () => {
  document.body.classList.toggle("dark");
  refresh();
});
if (location.hash.includes("dark")) {
  document.body.classList.add("dark");
  refresh();
}
