// sidebar_webview.ts — Browser entry point for the sidebar webview (#673).
// Runs inside the webview iframe (platform: browser, format: iife).
// Acquires the VS Code API and wires button clicks to bridge messages.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

(function () {
  const vscode = acquireVsCodeApi();

  // ── Button wiring ──────────────────────────────────────────────────────────

  const chatBtn = document.getElementById("btn-chat");
  const newProjectBtn = document.getElementById("btn-new-project");

  chatBtn?.addEventListener("click", () => {
    vscode.postMessage({ kind: "open-chat" });
  });

  newProjectBtn?.addEventListener("click", () => {
    vscode.postMessage({ kind: "new-project" });
  });

  // ── Host → Webview messages ────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.kind !== "string") return;

    switch (msg.kind) {
      case "chat-active":
        if (chatBtn) {
          chatBtn.classList.toggle("muted", !!msg.active);
        }
        break;
    }
  });
})();
