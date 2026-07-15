// Device Inspector webview entry — mounts the TS-composed view (media/ui/views/
// device_inspector.ts). No static markup: the view builds its own DOM from
// atoms/components; brand.css + layout.css are linked by the shell
// (device_inspector.ts). Mirrors inspector_webview.ts.

import { applyBrandAccent } from "../media/ui/brand_accent";
import { createDeviceInspectorView } from "../media/ui/views/device_inspector";

applyBrandAccent(); // theme-calculated Harmoniqs yellow (brand-wide contract)

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const view = createDeviceInspectorView((msg) => vscodeApi.postMessage(msg));
document.body.append(view.el);
window.addEventListener("message", (e) => view.onMessage(e.data));

vscodeApi.postMessage({ type: "log", text: "device_inspector_webview booted" });
