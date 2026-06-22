// Run Inspector webview script — runs inside the sandboxed Chromium webview.
//   - double-buffer image swap (zero flicker between iter frames at 5 Hz)
//   - status badge (idle / running / converged) + researcher metric cards
//     (objective, iteration, feasibility, optimality) driven by AMICODE_ITER.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};

const vscodeApi = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let visibleBuffer: "a" | "b" = "a";

function setBadge(state: "idle" | "running" | "done" | "failed", text: string): void {
  const badge = $("badge");
  badge.className = "badge " + state;
  badge.textContent = text;
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "ping": {
      vscodeApi.postMessage({ type: "pong", seq: msg.seq, t0: msg.t0 });
      break;
    }
    case "iteration": {
      $("m-obj-k").textContent = "objective";
      $("m-iter").textContent = String(msg.iter);
      $("m-obj").textContent = (msg.f_val as number).toExponential(4);
      $("m-pr").textContent = (msg.eq_viol as number).toExponential(2);
      $("m-du").textContent = (msg.kkt_error as number).toExponential(2);
      setBadge("running", "running");
      break;
    }
    case "warming": {
      // A run started but Julia/Makie are still compiling — show that instead of
      // an idle panel, so the cold start doesn't read as frozen.
      const ph = document.getElementById("placeholder");
      const hint = document.getElementById("m-hint");
      if (hint) hint.textContent = "Julia warming up — compiling the solver + plotter (~1–2 min). Frames will stream here.";
      if (ph) ph.hidden = false;
      setBadge("running", "warming up");
      break;
    }
    case "completed": {
      // Authoritative terminal state from the watcher (FINISHED on disk).
      const ok = msg.status === "completed";
      setBadge(ok ? "done" : "failed", ok ? "converged" : String(msg.status));
      // Promote the hero card to the final fidelity — the number that matters.
      if (ok && typeof msg.fidelity === "number") {
        $("m-obj-k").textContent = "fidelity";
        $("m-obj").textContent = (msg.fidelity as number).toFixed(5);
      }
      break;
    }
    case "refresh": {
      const placeholder = document.getElementById("placeholder");
      if (placeholder) placeholder.hidden = true;

      // Double-buffer image swap — preload into hidden buffer, flip opacity on decode.
      const incomingBuffer = visibleBuffer === "a" ? "b" : "a";
      const incomingImg = $("preview-" + incomingBuffer) as HTMLImageElement;
      const outgoingImg = $("preview-" + visibleBuffer) as HTMLImageElement;

      const handleLoaded = () => {
        incomingImg.style.opacity = "1";
        outgoingImg.style.opacity = "0";
        visibleBuffer = incomingBuffer;
        $("m-iter").textContent = String(msg.iter);
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
      setBadge("running", "running");   // a new frame means a live solve; completion arrives via "completed"
      break;
    }
  }
});

vscodeApi.postMessage({ type: "log", text: "inspector_webview booted" });
