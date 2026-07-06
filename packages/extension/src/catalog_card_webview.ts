// Catalog-card webview entry (#47) — mounts the card from host-injected data
// (window.__CARD_DATA__, hydrated from the real run dir by the save-to-catalog
// flow); the baked fixture below is the fallback for hostless debugging.

import { applyBrandAccent } from "../media/ui/brand_accent";
import { catalogcard, type CatalogEntry, type CardPulse } from "../media/ui/components/catalogcard";

applyBrandAccent();   // theme-calculated Harmoniqs yellow (brand-wide contract)

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare global { interface Window { __CARD_DATA__?: { entry: CatalogEntry; pulse?: CardPulse } } }

// Grounded in packages/schema/test/fixtures/valid/catalog-entry.toml; the
// `proposed` block is NOT schema — it renders visibly marked (field-selection
// feedback artifact for Krishna/Andrew).
const ENTRY: CatalogEntry = {
  schema_version: "1",
  run_id: "r20260615-000000Z-ab12",
  lab_id: "default",
  gate: "X",
  fidelity: 0.99995,
  pulse_path: "/Users/researcher/.amico/runs/default/r20260615-000000Z-ab12/pulse.jld2",
  created_at: "2026-06-15T00:00:00Z",
  params: { system: "transmon", levels: 3, T: 10.0, N: 50, drive_max: 0.2 },
  proposed: { tags: ["smooth"], index: 1, iterations: 60, wall_seconds: 41 },
};

const PULSE: CardPulse = {
  meta: { drives: 2, knots: 25, labels: ["u_1", "u_2"], bounds: [[-0.2, 0.2], [-0.2, 0.2]] },
  record: {
    iter: 60,
    dt: 0.4,
    values: [
      [0.012, 0.048, 0.096, 0.141, 0.172, 0.184, 0.176, 0.149, 0.108, 0.058,
       0.006, -0.043, -0.084, -0.113, -0.128, -0.127, -0.111, -0.083, -0.047, -0.008,
       0.028, 0.055, 0.068, 0.062, 0.033],
      [-0.021, -0.052, -0.079, -0.096, -0.100, -0.089, -0.065, -0.031, 0.009, 0.049,
       0.084, 0.109, 0.121, 0.118, 0.100, 0.070, 0.032, -0.009, -0.048, -0.079,
       -0.098, -0.102, -0.089, -0.061, -0.024],
    ],
  },
};

const SIBLINGS = [
  { gate: "X", system: "transmon", tags: ["fast"], index: 2 },
  { gate: "X", system: "transmon", tags: ["robust"], index: 3 },
  { gate: "H", system: "transmon", tags: ["smooth"], index: 7 },
];

const vscodeApi = acquireVsCodeApi();
const injected = window.__CARD_DATA__;
const card = catalogcard(injected?.entry ?? ENTRY, {
  pulse: injected ? injected.pulse : PULSE,
  siblings: injected ? [] : SIBLINGS,   // sibling entries need a store — none yet on the real path
  onAction: (id) => vscodeApi.postMessage({ type: "whatnext", id }),
});
document.body.style.padding = "16px";
document.body.append(card.el);
