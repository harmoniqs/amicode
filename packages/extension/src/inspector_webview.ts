// Run Inspector webview script — runs inside the sandboxed Chromium webview.
// Ported from amicode/src/spikes/inspector_webview.ts with no semantic changes:
//   - double-buffer image swap (zero flicker between iter frames at 5 Hz)
//   - canonical Ipopt-format stats row (iter, f, inf_pr, inf_du, lat)
//   - Date.now() for cross-process timestamp (performance.now origins differ).

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let iterCount = 0;
let lastIterAt = performance.now();
let smoothedHz = 0;
let visibleBuffer: "a" | "b" = "a";

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  const recv = performance.now();

  switch (msg.type) {
    case "ping": {
      vscodeApi.postMessage({ type: "pong", seq: msg.seq, t0: msg.t0 });
      $("status").textContent = "pinging";
      break;
    }
    case "iteration": {
      iterCount++;
      const dt = recv - lastIterAt;
      lastIterAt = recv;
      const instHz = dt > 0 ? 1000 / dt : 0;
      smoothedHz = smoothedHz === 0 ? instHz : 0.9 * smoothedHz + 0.1 * instHz;
      const lat = Date.now() - msg.t_post;
      $("iter").textContent = String(iterCount);
      $("hz").textContent = smoothedHz.toFixed(1);
      $("rec").textContent =
        `iter=${String(msg.iter).padStart(4, "0")}` +
        ` f=${(msg.f_val as number).toExponential(6)}` +
        ` inf_pr=${(msg.eq_viol as number).toExponential(3)}` +
        ` inf_du=${(msg.kkt_error as number).toExponential(3)}`;
      $("lat").textContent = `${lat.toFixed(0)}ms`;
      $("status").textContent = msg.isFinal ? "final frame" : "streaming";
      break;
    }
    case "refresh": {
      const placeholder = document.getElementById("placeholder");
      if (placeholder) placeholder.hidden = true;

      // Double-buffer image swap — preload into hidden buffer, flip opacity on decode.
      const incomingBuffer = visibleBuffer === "a" ? "b" : "a";
      const incomingImg = $("preview-" + incomingBuffer) as HTMLImageElement;
      const outgoingImg = $("preview-" + visibleBuffer) as HTMLImageElement;
      const tPost = msg.t_post as number;

      const handleLoaded = () => {
        const loadedAt = Date.now();
        incomingImg.style.opacity = "1";
        outgoingImg.style.opacity = "0";
        visibleBuffer = incomingBuffer;
        $("img-iter").textContent = String(msg.iter);
        $("img-load").textContent = `${(loadedAt - tPost).toFixed(0)}ms`;
      };

      incomingImg.src = msg.url;
      if (typeof incomingImg.decode === "function") {
        incomingImg.decode().then(handleLoaded).catch(handleLoaded);
      } else {
        incomingImg.addEventListener("load", function once() {
          incomingImg.removeEventListener("load", once);
          handleLoaded();
        });
      }
      $("status").textContent = msg.isFinal ? "final frame" : "streaming";
      break;
    }
  }
});

vscodeApi.postMessage({ type: "log", text: "inspector_webview booted" });
