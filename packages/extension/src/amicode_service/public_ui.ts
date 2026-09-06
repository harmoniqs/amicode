// PUBLIC UI PATHS (#823, the M3 cutover): the anonymous sub-resource surface,
// ported from the fork's packages/opencode/src/server/shared/public-ui.ts
// (v1.18.10-amicode.21 — itself carrying upstream's manifest exemptions).
//
// WHY at all: a browser's plain <script src>/<link href>/iframe-document
// fetches structurally CANNOT carry an Authorization header or the
// ?auth_token= carrier — gating them behind server auth blanks the whole
// framed UI whenever a password is set (the document authenticates via
// ?auth_token=, its own bundle 401s). The engine the service fronts exempts
// exactly these paths, so the service must too or the framed app it serves
// can never load its own shell.
//
//  - "/assets/"           the app shell's fingerprinted, content-hashed vite
//                          bundles — no secrets, GET-only, exact prefix.
//  - "/site.webmanifest" + the two manifest icons: the <head> manifest link
//                          (upstream's own exemptions).
//  - "/amicode/widget-frame" the widget frame DOCUMENT — an iframe request,
//                          same credential-less constraint; the served
//                          document embeds only registry widget code + the
//                          frame runtime (data arrives via the mediated
//                          postMessage bridge after boot). The widget
//                          REGISTRY route (/amicode/widgets) stays authed.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  "/amicode/widget-frame",
]);

export const PUBLIC_UI_PREFIX = "/assets/";

export function isPublicUiPath(method: string, pathname: string): boolean {
  return method === "GET" && (PUBLIC_UI_PATHS.has(pathname) || pathname.startsWith(PUBLIC_UI_PREFIX));
}
