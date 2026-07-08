// Onboarding/pulse-design storyboard webview entry (#46) — mounts the
// TS-composed view (media/ui/views/storyboard.ts). No static markup, no
// backend: this is a static, clickable frame sequence, fed by the view's own
// baked frame data.

import { applyBrandAccent } from "../media/ui/brand_accent";
import { createStoryboardView } from "../media/ui/views/storyboard";

applyBrandAccent(); // theme-calculated Harmoniqs yellow (brand-wide contract)

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscodeApi = acquireVsCodeApi();
const view = createStoryboardView();
document.body.append(view.el);
vscodeApi.postMessage({ type: "log", text: "storyboard_webview booted" });
