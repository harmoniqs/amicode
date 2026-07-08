// Catalog browser webview entry (#48, UX3 flat) — mounts the TS-composed
// view from a baked fixture set (no RunsManager/CatalogStore per the issue's
// seam-prototype approach). Fixtures are grounded in
// packages/schema/test/fixtures/valid/catalog-entry.toml, matching #47's
// catalog-card fixture shape.

import { applyBrandAccent } from "../media/ui/brand_accent";
import { createCatalogBrowserView, type CatalogBrowserData } from "../media/ui/views/catalogbrowser";
import type { CatalogEntry } from "../media/ui/components/catalogcard";

applyBrandAccent(); // theme-calculated Harmoniqs yellow (brand-wide contract)

const result = (over: Partial<CatalogEntry> & { proposed?: CatalogEntry["proposed"] }): CatalogEntry => ({
  schema_version: "1",
  run_id: over.run_id ?? "r0",
  lab_id: "default",
  fidelity: 0.999,
  pulse_path: "/Users/researcher/.amico/runs/default/r0/pulse.jld2",
  created_at: "2026-07-01T00:00:00Z",
  params: { system: "transmon", levels: 3, T: 10.0, N: 50, drive_max: 0.2 },
  ...over,
});

const DATA: CatalogBrowserData = {
  qilcRuns: [
    { run_id: "r20260707-140000Z-11aa", system: "transmon", gate: "CZ", iteration: 12, tags: ["fast"], hash6: "11aa22" },
    { run_id: "r20260707-153000Z-22bb", system: "fluxonium", gate: "H", iteration: 4, tags: ["robust"], hash6: "22bb33" },
  ],
  results: [
    {
      entry: result({
        run_id: "r20260706-000000Z-ab12",
        gate: "X",
        fidelity: 0.99995,
        proposed: { tags: ["smooth"], hash6: "ab12cd", iterations: 60, wall_seconds: 41 },
      }),
      pulse: {
        meta: { drives: 1, knots: 12, labels: ["u_1"], bounds: [[-0.2, 0.2]] },
        record: { iter: 60, dt: 0.4, values: [[0.01, 0.05, 0.09, 0.14, 0.17, 0.18, 0.17, 0.14, 0.09, 0.05, 0.01, -0.02]] },
      },
    },
    {
      entry: result({
        run_id: "r20260705-000000Z-cd34",
        gate: "CZ",
        fidelity: 0.9987,
        params: { system: "transmon", levels: 3, T: 40.0, N: 80, drive_max: 0.2 },
        proposed: { tags: ["fast"], hash6: "cd34ef", iterations: 90, wall_seconds: 120 },
      }),
    },
    {
      entry: result({
        run_id: "r20260703-000000Z-ef56",
        gate: "H",
        fidelity: 0.9999,
        params: { system: "fluxonium", levels: 4, T: 25.0, N: 60, drive_max: 0.15 },
        proposed: { tags: ["robust"], hash6: "ef56ab", iterations: 45, wall_seconds: 33 },
      }),
    },
  ],
};

const view = createCatalogBrowserView(DATA);
document.body.style.height = "100vh";
document.body.style.margin = "0";
document.body.append(view.el);
