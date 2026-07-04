// Style registry — atoms/components/views own their styles in TS, injected
// once per key via constructable stylesheets (not governed by style-src CSP).
// Values come from brand.css variables; layout comes from layout.css selectors.

const registered = new Set<string>();

export function defineStyle(key: string, css: string): void {
  if (registered.has(key)) return;
  registered.add(key);
  // No-op outside a browser (node/vitest): lets view modules be imported for
  // unit tests of their pure exports without a DOM / constructable-stylesheet.
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
