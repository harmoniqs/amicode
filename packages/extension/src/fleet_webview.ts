// Fleet Panel webview entry — mounts the TS-composed view (media/ui/views/
// fleet.ts). No static markup: the view builds its own DOM from atoms/components;
// brand.css + layout.css are linked by the shell (fleet_panel.ts).
// Mirrors device_inspector_webview.ts.

import { applyBrandAccent } from "../media/ui/brand_accent";
import { createFleetView } from "../media/ui/views/fleet";

applyBrandAccent(); // theme-calculated Harmoniqs yellow (brand-wide contract)

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const view = createFleetView((msg) => vscodeApi.postMessage(msg));
document.body.append(view.el);
window.addEventListener("message", (e) => view.onMessage(e.data));

vscodeApi.postMessage({ type: "log", text: "fleet_webview booted" });
