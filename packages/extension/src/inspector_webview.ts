// Run Inspector webview entry — mounts the TS-composed view (media/ui/views/
// inspector.ts). No static markup: the view builds its own DOM from atoms/
// components; brand.css + layout.css are linked by the shell (run_inspector.ts).

import { applyBrandAccent } from "../media/ui/brand_accent";
import { createInspectorView } from "../media/ui/views/inspector";

applyBrandAccent(); // theme-calculated Harmoniqs yellow (brand-wide contract)

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const view = createInspectorView((msg) => vscodeApi.postMessage(msg));
document.body.append(view.el);
window.addEventListener("message", (e) => view.onMessage(e.data));

vscodeApi.postMessage({ type: "log", text: "inspector_webview booted" });
