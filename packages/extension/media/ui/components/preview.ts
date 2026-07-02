// Preview component — double-buffered image host with a placeholder overlay.
// Preloads each frame into the hidden buffer and flips opacity on decode, so
// iter frames swap at 5 Hz with zero flicker.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { mark } from "../atoms/icon";

defineStyle("preview", `
  .preview-host { flex: 1 1 240px; min-height: 240px; min-width: 0; position: relative;
                  background: var(--bg-plot);
                  border: var(--border-width) solid var(--border-color);
                  border-radius: var(--border-radius); padding: var(--space-sm);
                  display: grid; place-items: stretch; overflow: hidden; }
  .preview-host img { grid-column: 1; grid-row: 1; width: 100%; height: 100%;
                      object-fit: contain; display: block; opacity: 0;
                      transition: opacity 120ms ease; }
  .preview-placeholder { place-self: center; text-align: center; opacity: 0.55;
                         display: flex; flex-direction: column; align-items: center;
                         gap: var(--space-sm); }
  .preview-placeholder .mark { font-size: var(--text-hero); padding: var(--space-xs) var(--space-md); opacity: 0.8; }
  .preview-placeholder .hint { font-style: italic; max-width: 240px; line-height: 1.5; }
`);

export interface Preview {
  el: HTMLDivElement;
  /** Show a frame; onShown fires after the buffer flip. */
  show(url: string, onShown: () => void): void;
  /** Clear both buffers and surface the placeholder with a hint. */
  waiting(hint: string): void;
}

export function preview(initialHint: string): Preview {
  const el = document.createElement("div");
  el.className = "preview-host";
  const a = document.createElement("img");
  const b = document.createElement("img");
  const hint = text("hint", initialHint);
  const placeholder = document.createElement("div");
  placeholder.className = "preview-placeholder";
  placeholder.append(mark(), hint.el);
  el.append(a, b, placeholder);
  let visible = a;

  return {
    el,
    show(url, onShown) {
      placeholder.style.display = "none";
      const incoming = visible === a ? b : a;
      const outgoing = visible;
      const flip = () => {
        incoming.style.opacity = "1";
        outgoing.style.opacity = "0";
        visible = incoming;
        onShown();
      };
      incoming.src = url;
      if (typeof incoming.decode === "function") {
        incoming.decode().then(flip).catch(flip);
      } else {
        incoming.addEventListener("load", function once() {
          incoming.removeEventListener("load", once);
          flip();
        });
      }
    },
    waiting(hintText) {
      a.style.opacity = "0";
      b.style.opacity = "0";
      hint.set(hintText);
      placeholder.style.display = "flex";
    },
  };
}
